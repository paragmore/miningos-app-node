'use strict'

const { getHashrate, getConsumption } = require('../../../handlers/metrics.handlers')
const {
  getCostParameters,
  getProductionCosts,
  resolveCostParametersForMonth
} = require('../../../handlers/finance.handlers')
const { formatDateTime } = require('../mappers')
const { rollupLocalDays, rollupLocalMonths, poolPctOfNominal, invoicePeriodPoolPctOfNominal } = require('../../../../metrics.utils')

const SECONDS = { hour: 3600 }
const EXPORT_PRECISION = 3
const PCT_OF_NOMINAL_PRECISION = 2

const BREAKDOWN_COLUMNS = [
  'year', 'month', 'energyConsumedMwh', 'lcoeUsdPerMwh', 'energyCostsUsd', 'operationalCostUsd',
  'pctOfNominal', 'minerAmortizationUsd', 'infraAmortizationUsd', 'amortizationUsd',
  'amortizationPayableUsd', 'marginPct', 'marginUsd', 'monthlyInvoiceUsd'
]

function isRangeTs (value) {
  return Number.isFinite(value) && value > 0
}

// Same bounds as validateStartEnd, which every fetch below runs into: without
// them a degenerate range fails there instead, as a 500 rather than a 400.
function assertRange (params) {
  if (!isRangeTs(params.start) || !isRangeTs(params.end)) {
    throw new Error('ERR_EXPORT_RANGE_REQUIRED')
  }
  if (params.start >= params.end) throw new Error('ERR_EXPORT_RANGE_INVALID')
}

function dateParts (ts, timezone) {
  const parts = {}
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit'
  }).formatToParts(new Date(ts))
  for (const { type, value } of formatted) parts[type] = value
  return parts
}

function monthName (ts, timezone) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'long' }).format(new Date(ts))
}

function roundRow (row) {
  return Object.fromEntries(Object.entries(row).map(([column, value]) => {
    const precision = column === 'pctOfNominal' ? PCT_OF_NOMINAL_PRECISION : EXPORT_PRECISION
    return [column, typeof value === 'number' ? Number(value.toFixed(precision)) : value]
  }))
}

function num (value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

// Any missing input propagates as null, never 0: an absent cost parameter must
// not read as a free month on the invoice.
function derive (inputs, fn) {
  return inputs.some((value) => value === null) ? null : fn(...inputs)
}

function buildHashesEntry ({ type, interval, seconds, rollup, filenamePrefix, periodColumns, mapPeriod }) {
  return {
    type,
    perms: ['reporting:r'],
    jsonRootKey: 'hashes',
    columns: [...periodColumns, 'hashesDeliveredEh', 'pctOfNominal', 'avgMinerHashratePhs', 'avgPoolHashratePhs'],
    filenamePrefix () {
      return filenamePrefix
    },
    assertParams: assertRange,
    async fetchExport (ctx, { params, now, timezone }) {
      const { log } = await getHashrate(ctx, {
        query: { start: params.start, end: params.end, interval, nominal: true, siteNominal: true, pool: true }
      })
      const buckets = rollup ? rollup(log, timezone) : log

      async function * rows () {
        for (const entry of buckets) {
          const hashrateMhs = num(entry.hashrateMhs)
          const poolHashrateMhs = num(entry.poolHashrateMhs)
          yield roundRow({
            ...mapPeriod(entry.ts, timezone),
            hashesDeliveredEh: derive([poolHashrateMhs], (mhs) => (mhs * (entry.poolSeconds ?? seconds)) / 1e12),
            pctOfNominal: rollup ? entry.pctOfNominal : poolPctOfNominal([entry]),
            avgMinerHashratePhs: derive([hashrateMhs], (mhs) => mhs / 1e9),
            avgPoolHashratePhs: derive([poolHashrateMhs], (mhs) => mhs / 1e9)
          })
        }
      }

      return {
        rows: rows(),
        jsonMeta: { dateExported: formatDateTime(now, timezone) }
      }
    }
  }
}

const invoicingHourlyHashes = buildHashesEntry({
  type: 'invoicing-hourly-hashes',
  interval: '1h',
  seconds: SECONDS.hour,
  filenamePrefix: 'invoicing_hourly_hashes_',
  periodColumns: ['date', 'hour'],
  mapPeriod (ts, timezone) {
    const parts = dateParts(ts, timezone)
    return { date: `${parts.day}/${parts.month}/${parts.year}`, hour: `${parts.hour}:00` }
  }
})

const invoicingDailyHashes = buildHashesEntry({
  type: 'invoicing-daily-hashes',
  interval: '1h',
  rollup: rollupLocalDays,
  filenamePrefix: 'invoicing_daily_hashes_',
  periodColumns: ['month', 'day'],
  mapPeriod (ts, timezone) {
    return { month: monthName(ts, timezone), day: dateParts(ts, timezone).day }
  }
})

// Same hourly source as the daily export: the site's calendar month cannot be formed
// from the backend's UTC-aligned daily buckets, so the months are rolled up here.
const invoicingMonthlyHashes = buildHashesEntry({
  type: 'invoicing-monthly-hashes',
  interval: '1h',
  rollup: rollupLocalMonths,
  filenamePrefix: 'invoicing_monthly_hashes_',
  periodColumns: ['year', 'month'],
  mapPeriod (ts, timezone) {
    return { year: dateParts(ts, timezone).year, month: monthName(ts, timezone) }
  }
})

const invoiceBreakdown = {
  type: 'invoice-breakdown',
  perms: ['reporting:r'],
  jsonRootKey: 'breakdown',
  columns: BREAKDOWN_COLUMNS,
  filenamePrefix () {
    return 'invoice_breakdown_'
  },
  assertParams: assertRange,
  async fetchExport (ctx, { params, now, timezone }) {
    const { start, end } = params
    // localMonth: the caller sends the requested timezone's calendar month and the
    // invoice is summed from hourly buckets, since daily ones are UTC-aligned and
    // cannot form a local month. Without it the range is the UTC month the UI has
    // always sent, read in UTC so a west-of-UTC label timezone does not bill the
    // month before.
    const localMonth = params.localMonth === true || params.localMonth === 'true'
    const interval = localMonth ? '1h' : '1d'
    const [hashrate, consumption, costParameters, productionCosts] = await Promise.all([
      getHashrate(ctx, { query: { start, end, interval, nominal: true, siteNominal: true, pool: true } }),
      getConsumption(ctx, { query: { start, end, interval } }),
      getCostParameters(ctx),
      getProductionCosts(ctx, start, end)
    ])

    const { year, month } = dateParts(start, localMonth ? timezone : 'UTC')
    const resolved = resolveCostParametersForMonth(costParameters, `${year}-${month}`)
    const costs = productionCosts.find(
      (entry) => Number(entry.year) === Number(year) && Number(entry.month) === Number(month)
    )

    const energyConsumedMwh = consumption.summary.avgPowerW === null
      ? null
      : num(consumption.summary.totalConsumptionMWh)
    const lcoeUsdPerMwh = num(resolved.lcoe?.effectiveUsdPerMwh)
    const energyCostsUsd = derive([energyConsumedMwh, lcoeUsdPerMwh], (mwh, lcoe) => mwh * lcoe)
    const operationalCostUsd = num(costs?.operationalCost ?? costs?.operationalCostsUSD)
    // Invoice-month basis: hours without pool data count as zero delivered (see
    // invoicePeriodPoolPctOfNominal) - the hourly/daily rows above keep the
    // coverage basis on purpose.
    const pctOfNominal = invoicePeriodPoolPctOfNominal(hashrate.log)
    const minerAmortizationUsd = num(resolved.minerAmortizationUsd)
    const infraAmortizationUsd = num(resolved.infraAmortizationUsd)
    const amortizationUsd = derive([minerAmortizationUsd, infraAmortizationUsd], (miner, infra) => miner + infra)
    const amortizationPayableUsd = derive([pctOfNominal, amortizationUsd], (pct, total) => (pct / 100) * total)
    const marginPct = num(resolved.marginPct)
    const baseUsd = derive(
      [energyCostsUsd, operationalCostUsd, amortizationPayableUsd],
      (energy, operational, payable) => energy + operational + payable
    )
    const marginUsd = derive([marginPct, baseUsd], (pct, total) => (pct / 100) * total)

    const row = {
      year: Number(year),
      month: Number(month),
      energyConsumedMwh,
      lcoeUsdPerMwh,
      energyCostsUsd,
      operationalCostUsd,
      pctOfNominal,
      minerAmortizationUsd,
      infraAmortizationUsd,
      amortizationUsd,
      amortizationPayableUsd,
      marginPct,
      marginUsd,
      monthlyInvoiceUsd: derive([baseUsd, marginUsd], (total, margin) => total + margin)
    }

    async function * rows () {
      yield roundRow(row)
    }

    return {
      rows: rows(),
      jsonMeta: { dateExported: formatDateTime(now, timezone) }
    }
  }
}

module.exports = { invoicingHourlyHashes, invoicingDailyHashes, invoicingMonthlyHashes, invoiceBreakdown, assertRange }
