'use strict'

const { PERIOD_TYPES } = require('../../../../constants')
const { getRevenueSummary, extractForecastSettings, extractNominalPower } = require('../../../handlers/finance.handlers')
const { getForecastSettings } = require('../../../handlers/energy.handlers')
const { getGlobalConfig } = require('../../../handlers/global.handlers')
const { getHashrate } = require('../../../handlers/metrics.handlers')
const { formatDateTime } = require('../mappers')
const { assertRange } = require('./invoicing.export')

const HOUR_MS = 3600000

const FINANCIALS_COLUMNS = [
  'miningNetUsd', 'miningGrossUsd', 'miningNetUsdPerMwh',
  'energySalesNetUsd', 'energySalesGrossUsd', 'energySalesNetUsdPerMwh',
  'totalNetUsd', 'totalGrossUsd', 'totalNetUsdPerMwh',
  'opexUsd', 'opexUsdPerMwh',
  'netCashUsd', 'cashMarginPct', 'netCashUsdPerMwh',
  'allSellNetUsd', 'avgSaleValueUsdPerMwh'
]

const PRODUCTION_COLUMNS = [
  'btcMined', 'btcFromPayouts', 'btcFromRebates', 'btcMinedUsdAtReport',
  'energyConsumedMwh', 'miningConsumptionMwh', 'minedPct', 'soldPct', 'curtailedPct',
  'avgHashratePhs', 'pctOfNominal', 'avgEfficiencyJPerTh',
  'uptimePct', 'downtimeMwh',
  'btcProductionCostUsd', 'lcoeUsdPerMwh', 'currentBtcPriceUsd'
]

const DETAIL_COLUMNS = [
  'period', 'btcMined', 'miningNetUsd', 'energySalesNetUsd', 'totalNetUsd', 'opexUsd',
  'netCashUsd', 'mwhMined', 'mwhSold', 'mineUsdPerMwh', 'sellUsdPerMwh', 'capturePct'
]

const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null)
const pct = (numerator, denominator) => (denominator > 0 ? (numerator / denominator) * 100 : null)
const sum = (entries, key) => entries.reduce((total, entry) => total + (entry[key] || 0), 0)

// The page's months are UTC months, capped at "now" for the running one.
function hoursInMonth (ts, asOf) {
  const date = new Date(ts)
  const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
  const end = Math.min(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1), asOf)
  return Math.max(0, (end - start) / HOUR_MS)
}

function bucketLabel (ts, bucket) {
  const date = new Date(ts)
  const year = date.getUTCFullYear()
  if (bucket === 'yearly') return `${year}`
  const yy = String(year).slice(-2)
  if (bucket === 'quarterly') return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${yy}`
  return `${date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${yy}`
}

// "At report" re-values the BTC at today's price; only the percent part of the mining
// tax scales with revenue, so the fixed $/MWh part stays as booked.
function totals (entries, { atReport, currentBtcPrice, taxRetention, nominalMW, asOf }) {
  const revenueBTC = sum(entries, 'revenueBTC')
  const revenueUSD = sum(entries, 'revenueUSD')
  const delta = atReport && currentBtcPrice > 0 ? revenueBTC * currentBtcPrice - revenueUSD : 0
  const miningNetReceiptUSD = sum(entries, 'miningNetUSD')
  const miningNetUSD = miningNetReceiptUSD + delta * taxRetention
  const energySalesNetUSD = sum(entries, 'energySalesNetUSD')
  return {
    revenueBTC,
    miningGrossUSD: revenueUSD + delta,
    miningNetUSD,
    miningNetReceiptUSD,
    energySalesNetUSD,
    totalNetUSD: miningNetUSD + energySalesNetUSD,
    opexUSD: sum(entries, 'totalCostsUSD'),
    netCashUSD: sum(entries, 'netCashUSD') + delta * taxRetention,
    consumptionMWh: sum(entries, 'consumptionMWh'),
    soldMWh: sum(entries, 'soldMWh'),
    capacityMWh: nominalMW * entries.reduce((hours, entry) => hours + hoursInMonth(entry.ts, asOf), 0)
  }
}

function detailRow (entries, period, opts) {
  const t = totals(entries, opts)
  return {
    period,
    btcMined: t.revenueBTC,
    miningNetUsd: t.miningNetUSD,
    energySalesNetUsd: t.energySalesNetUSD,
    totalNetUsd: t.totalNetUSD,
    opexUsd: t.opexUSD,
    netCashUsd: t.netCashUSD,
    mwhMined: t.consumptionMWh,
    mwhSold: t.soldMWh,
    mineUsdPerMwh: ratio(sum(entries, 'allMineNetUSD'), t.capacityMWh),
    sellUsdPerMwh: ratio(sum(entries, 'allSellNetUSD'), t.capacityMWh),
    capturePct: pct(t.miningNetReceiptUSD + t.energySalesNetUSD, sum(entries, 'optimalNetUSD'))
  }
}

function detailRows (log, bucket, opts) {
  const groups = new Map()
  for (const entry of log) {
    const period = bucketLabel(entry.ts, bucket)
    groups.set(period, [...(groups.get(period) ?? []), entry])
  }
  return [
    ...[...groups].map(([period, entries]) => detailRow(entries, period, opts)),
    detailRow(log, 'Total', opts)
  ]
}

function financialsRow (log, summary, opts) {
  const t = totals(log, opts)
  const utilizedMWh = t.consumptionMWh + t.soldMWh
  return {
    miningNetUsd: t.miningNetUSD,
    miningGrossUsd: t.miningGrossUSD,
    miningNetUsdPerMwh: ratio(t.miningNetUSD, t.consumptionMWh),
    energySalesNetUsd: t.energySalesNetUSD,
    energySalesGrossUsd: summary.totalEnergySalesGrossUSD,
    energySalesNetUsdPerMwh: ratio(t.energySalesNetUSD, t.soldMWh),
    totalNetUsd: t.totalNetUSD,
    totalGrossUsd: t.miningGrossUSD + summary.totalEnergySalesGrossUSD,
    totalNetUsdPerMwh: ratio(t.totalNetUSD, utilizedMWh),
    opexUsd: t.opexUSD,
    opexUsdPerMwh: ratio(t.opexUSD, t.consumptionMWh),
    netCashUsd: t.netCashUSD,
    cashMarginPct: pct(t.netCashUSD, t.totalNetUSD),
    netCashUsdPerMwh: ratio(t.netCashUSD, utilizedMWh),
    allSellNetUsd: summary.totalAllSellNetUSD,
    avgSaleValueUsdPerMwh: ratio(summary.totalAllSellNetUSD, t.capacityMWh)
  }
}

function productionRow (log, summary, hashrate, opts) {
  const t = totals(log, opts)
  const efficient = log.filter((entry) => entry.hashrateMhs > 0 && entry.consumptionMWh > 0)
  const efficiencyWeight = sum(efficient, 'consumptionMWh')
  return {
    btcMined: summary.totalRevenueBTC,
    btcFromPayouts: summary.totalPayoutBTC,
    btcFromRebates: summary.totalRebateBTC,
    btcMinedUsdAtReport: summary.totalRevenueBTC * summary.currentBtcPrice,
    energyConsumedMwh: t.consumptionMWh,
    miningConsumptionMwh: summary.totalMiningConsumptionMWh,
    minedPct: pct(t.consumptionMWh, t.capacityMWh),
    soldPct: pct(t.soldMWh, t.capacityMWh),
    curtailedPct: pct(sum(log, 'curtailmentMWh'), t.capacityMWh),
    avgHashratePhs: hashrate.avgPoolHashrateMhs == null ? null : hashrate.avgPoolHashrateMhs / 1e9,
    pctOfNominal: hashrate.avgPctOfNominal ?? null,
    avgEfficiencyJPerTh: ratio(
      efficient.reduce((acc, entry) => acc + (entry.powerW / (entry.hashrateMhs / 1e6)) * entry.consumptionMWh, 0),
      efficiencyWeight
    ),
    uptimePct: pct(t.consumptionMWh + t.soldMWh, t.capacityMWh),
    downtimeMwh: Math.max(0, sum(log, 'downtimeMWh')),
    btcProductionCostUsd: ratio(summary.totalCostsUSD, summary.totalRevenueBTC),
    lcoeUsdPerMwh: log.findLast((entry) => entry.lcoeUsdPerMwh != null)?.lcoeUsdPerMwh ?? null,
    currentBtcPriceUsd: summary.currentBtcPrice
  }
}

// Same reads as the Project Financials page: monthly revenue-summary, the forecast
// settings' mining tax (for "at report"), and the site's nominal power (for capacity).
async function fetchProjectFinancials (ctx, params, now, withHashrate) {
  const query = { start: params.start, end: params.end, timezone: params.timezone }
  const [revenueSummary, forecastSettings, globalConfig, hashrate] = await Promise.all([
    getRevenueSummary(ctx, { query: { ...query, period: PERIOD_TYPES.MONTHLY } }),
    getForecastSettings(ctx),
    getGlobalConfig(ctx, { query: {} }),
    withHashrate && getHashrate(ctx, { query: { ...query, interval: '1d', pool: true, nominal: true } })
  ])
  const { summary } = revenueSummary
  return {
    log: [...revenueSummary.log].sort((a, b) => a.ts - b.ts),
    summary,
    hashrate: hashrate?.summary ?? {},
    opts: {
      atReport: params.valuation === 'report',
      currentBtcPrice: summary.currentBtcPrice,
      taxRetention: 1 - (extractForecastSettings(forecastSettings).miningRevenueTaxFees?.percent ?? 0) / 100,
      nominalMW: extractNominalPower(globalConfig),
      asOf: now.getTime()
    }
  }
}

function buildEntry ({ type, jsonRootKey, columns, withHashrate, buildRows }) {
  return {
    type,
    perms: ['reporting:r'],
    jsonRootKey,
    columns,
    filenamePrefix () {
      return `${type.replace(/-/g, '_')}_`
    },
    assertParams (params) {
      assertRange(params)
      // Phase-scoped exports wait for the consumption workstream: the revenue
      // columns would be phase-scoped while every energy column stays
      // site-wide. Reject instead of silently exporting the whole site.
      if (params.phase && params.phase !== 'total') {
        throw new Error('ERR_PHASE_NOT_SUPPORTED')
      }
    },
    async fetchExport (ctx, { params, now, timezone }) {
      const data = await fetchProjectFinancials(ctx, params, now, withHashrate)
      const rows = data.log.length ? buildRows(data, params) : []
      return {
        rows: (async function * () { yield * rows })(),
        jsonMeta: { dateExported: formatDateTime(now, timezone) }
      }
    }
  }
}

const projectFinancialsFinancials = buildEntry({
  type: 'project-financials-financials',
  jsonRootKey: 'financials',
  columns: FINANCIALS_COLUMNS,
  buildRows: ({ log, summary, opts }) => [financialsRow(log, summary, opts)]
})

const projectFinancialsProduction = buildEntry({
  type: 'project-financials-production',
  jsonRootKey: 'production',
  columns: PRODUCTION_COLUMNS,
  withHashrate: true,
  buildRows: ({ log, summary, hashrate, opts }) => [productionRow(log, summary, hashrate, opts)]
})

const projectFinancialsDetail = buildEntry({
  type: 'project-financials-detail',
  jsonRootKey: 'detail',
  columns: DETAIL_COLUMNS,
  buildRows: ({ log, opts }, params) => detailRows(log, params.bucket, opts)
})

module.exports = {
  projectFinancialsFinancials,
  projectFinancialsProduction,
  projectFinancialsDetail,
  detailRows,
  financialsRow,
  productionRow
}
