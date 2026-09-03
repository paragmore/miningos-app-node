'use strict'

const { getHashrate, getConsumption } = require('../../../handlers/metrics.handlers')
const {
  getCostParameters,
  getProductionCosts,
  resolveCostParametersForMonth
} = require('../../../handlers/finance.handlers')
const { formatDateTime } = require('../mappers')

const SECONDS = { hour: 3600, day: 86400 }
const EXPORT_PRECISION = 3

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

// The UI rounds every exported figure to 3 decimals; matching it keeps a CSV
// pulled from the API identical to one saved from the invoice screen.
function roundRow (row) {
  return Object.fromEntries(Object.entries(row).map(
    ([column, value]) => [column, typeof value === 'number' ? Number(value.toFixed(EXPORT_PRECISION)) : value]
  ))
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

function buildHashesEntry ({ type, interval, seconds, filenamePrefix, periodColumns, mapPeriod }) {
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
        query: { start: params.start, end: params.end, interval, nominal: true, pool: true }
      })

      async function * rows () {
        for (const entry of log) {
          const hashrateMhs = num(entry.hashrateMhs)
          yield roundRow({
            ...mapPeriod(entry.ts, timezone),
            hashesDeliveredEh: derive([hashrateMhs], (mhs) => (mhs * seconds) / 1e12),
            pctOfNominal: num(entry.pctOfNominal),
            avgMinerHashratePhs: derive([hashrateMhs], (mhs) => mhs / 1e9),
            avgPoolHashratePhs: derive([num(entry.poolHashrateMhs)], (mhs) => mhs / 1e9)
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
  interval: '1d',
  seconds: SECONDS.day,
  filenamePrefix: 'invoicing_daily_hashes_',
  periodColumns: ['month', 'day'],
  mapPeriod (ts, timezone) {
    return { month: monthName(ts, timezone), day: dateParts(ts, timezone).day }
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
    const [hashrate, consumption, costParameters, productionCosts] = await Promise.all([
      getHashrate(ctx, { query: { start, end, interval: '1d', nominal: true } }),
      getConsumption(ctx, { query: { start, end, interval: '1d' } }),
      getCostParameters(ctx),
      getProductionCosts(ctx, start, end)
    ])

    // The invoice month is read in UTC, not in the requested timezone: the UI asks
    // for exact UTC month bounds and only sends its own timezone to label rows, so
    // resolving the month locally would bill a west-of-UTC site against the month before.
    const { year, month } = dateParts(start, 'UTC')
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
    const pctOfNominal = num(hashrate.summary.avgPctOfNominal)
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

module.exports = { invoicingHourlyHashes, invoicingDailyHashes, invoiceBreakdown }
