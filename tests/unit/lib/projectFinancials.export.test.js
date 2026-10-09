'use strict'

const test = require('brittle')
const { EXPORT_TYPES } = require('../../../workers/lib/server/lib/export/registry')
const { detailRows, financialsRow, productionRow } = require('../../../workers/lib/server/lib/export/types/projectFinancials.export')

const JAN = Date.UTC(2026, 0, 1)
const FEB = Date.UTC(2026, 1, 1)
const month = (ts, overrides) => ({
  ts,
  revenueBTC: 1,
  revenueUSD: 100000,
  miningNetUSD: 90000,
  energySalesNetUSD: 1000,
  totalCostsUSD: 20000,
  netCashUSD: 71000,
  consumptionMWh: 600,
  soldMWh: 0,
  allMineNetUSD: 7440,
  allSellNetUSD: 744,
  optimalNetUSD: 10000,
  ...overrides
})
const log = [month(JAN), month(FEB, { revenueBTC: 0.5, revenueUSD: 50000 })]
// 1 MW nominal, 10% mining tax, both months over: capacity is 744 h + 672 h.
const opts = (atReport) => ({ atReport, currentBtcPrice: 120000, taxRetention: 0.9, nominalMW: 1, asOf: Date.now() })

test('project financials exports are registered', async (t) => {
  for (const type of ['project-financials-financials', 'project-financials-production', 'project-financials-detail']) {
    t.ok(EXPORT_TYPES.includes(type), type)
  }
})

test('project financials detail mirrors the page table, bucketed and valued as requested', async (t) => {
  const monthly = detailRows(log, 'monthly', opts(false))
  t.alike(monthly.map((row) => row.period), ['Jan 26', 'Feb 26', 'Total'])
  t.is(monthly[0].mineUsdPerMwh, 10, 'capacity is nominal MW x hours in the month')
  t.is(monthly[0].capturePct, 910)

  const [q1, total] = detailRows(log, 'quarterly', opts(true))
  t.is(q1.period, 'Q1 26')
  // At report: 1.5 BTC x 120k - 150k booked = 30k, of which 90% survives the mining tax.
  t.is(q1.miningNetUsd, 180000 + 27000)
  t.is(q1.netCashUsd, 142000 + 27000)
  t.alike(total, { ...q1, period: 'Total' })
})

test('project financials and production sections export the page tiles', async (t) => {
  const summary = { currentBtcPrice: 120000, totalEnergySalesGrossUSD: 3000, totalAllSellNetUSD: 1488, totalRevenueBTC: 1.5, totalCostsUSD: 40000 }
  const financials = financialsRow(log, summary, opts(false))
  t.is(financials.totalNetUsd, 182000)
  t.is(financials.totalGrossUsd, 153000)
  t.is(financials.cashMarginPct, (142000 / 182000) * 100)

  const production = productionRow(log, summary, {}, opts(false))
  t.is(production.uptimePct, (1200 / (744 + 672)) * 100)
  t.is(production.btcProductionCostUsd, 40000 / 1.5)
  t.is(production.avgHashratePhs, null, 'no pool hashrate is unknown, not zero')
})

test('project financials exports reject a concrete phase until consumption splits', async (t) => {
  const { projectFinancialsProduction, projectFinancialsDetail, projectFinancialsFinancials } = require('../../../workers/lib/server/lib/export/types/projectFinancials.export')
  const range = { start: 1700000000000, end: 1700100000000 }

  for (const entry of [projectFinancialsProduction, projectFinancialsDetail, projectFinancialsFinancials]) {
    t.exception(() => entry.assertParams({ ...range, phase: 'phase1_5' }), /ERR_PHASE_NOT_SUPPORTED/, `${entry.type} rejects a phase`)
    entry.assertParams({ ...range, phase: 'total' })
    entry.assertParams(range)
  }
  t.pass()
})
