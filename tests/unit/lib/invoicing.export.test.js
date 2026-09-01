'use strict'

const test = require('brittle')
const { getExportType, resolveExport, EXPORT_TYPES } = require('../../../workers/lib/server/lib/export/registry')
const { withDataProxy } = require('../helpers/mockHelpers')

const HOUR_MS = 3600000
const DAY_MS = 24 * HOUR_MS
const START = Date.UTC(2026, 7, 1)
const MHS = 1e11
const NOMINAL_MHS = 1.25e11
const POOL_HS = 9.9e16 // 99 PH/s, pool stats are in H/s

function mockCtx ({ buckets = 3, interval = HOUR_MS, globalData = {}, hashrateMhs = MHS, poolHashrateHs = POOL_HS } = {}) {
  return withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    globalDataLib: { getGlobalData: async ({ type }) => globalData[type] },
    net_r0: {
      jRequest: async (key, method, params) => {
        if (method === 'getWrkExtData') {
          return Array.from({ length: buckets }, (_, i) => ({
            ts: START + i * interval + 1000,
            stats: [{ poolType: 'f2pool', username: 'account-a', hashrate: poolHashrateHs }]
          }))
        }
        return Array.from({ length: buckets }, (_, i) => ({
          ts: START + i * interval,
          ...(params.type === 'powermeter'
            ? { site_power_w: 10e6 }
            : { hashrate_mhs_5m_sum_aggr: hashrateMhs, nominal_hashrate_mhs_sum_aggr: NOMINAL_MHS })
        }))
      }
    }
  })
}

async function runExport (type, params, ctxOpts) {
  const entry = getExportType(type)
  entry.assertParams(params)
  const { filename, stream } = await resolveExport(mockCtx(ctxOpts), entry, params)
  let out = ''
  for await (const chunk of stream) out += chunk
  return { filename, out }
}

test('invoicing exports are registered as reporting exports', async (t) => {
  for (const type of ['invoicing-hourly-hashes', 'invoicing-daily-hashes', 'invoice-breakdown']) {
    t.ok(EXPORT_TYPES.includes(type), `${type} is an accepted export type`)
    t.alike(getExportType(type).perms, ['reporting:r'], `${type} is gated on reporting`)
  }
  t.pass()
})

test('invoicing exports require a valid range', async (t) => {
  const entry = getExportType('invoice-breakdown')

  t.exception(() => entry.assertParams({}), /ERR_EXPORT_RANGE_REQUIRED/)
  t.exception(() => entry.assertParams({ start: 2 }), /ERR_EXPORT_RANGE_REQUIRED/, 'an absent end is not a range')
  t.exception(() => entry.assertParams({ start: 0, end: START }), /ERR_EXPORT_RANGE_REQUIRED/)
  t.exception(() => entry.assertParams({ start: 2, end: 1 }), /ERR_EXPORT_RANGE_INVALID/)
  t.exception(() => entry.assertParams({ start: START, end: START }), /ERR_EXPORT_RANGE_INVALID/, 'an empty range is rejected here, not deeper as a 500')
  t.pass()
})

test('invoicing exports round every figure to three decimals', async (t) => {
  const { out } = await runExport(
    'invoicing-hourly-hashes',
    { start: START, end: START + HOUR_MS, timezone: 'UTC', format: 'csv' },
    { buckets: 1, hashrateMhs: 123456789012.3 }
  )

  t.is(out.split('\n')[1], '"01/08/2026","00:00","444.444","98.765","123.457","99"', 'matches the precision the UI exports')
  t.pass()
})

test('invoicing-hourly-hashes - one row per hour, EH delivered over the hour', async (t) => {
  const { filename, out } = await runExport(
    'invoicing-hourly-hashes',
    { start: START, end: START + 3 * HOUR_MS, timezone: 'UTC', format: 'csv' },
    { buckets: 3 }
  )
  const lines = out.split('\n')

  t.ok(filename.startsWith('invoicing_hourly_hashes_'), 'filename names the export')
  t.is(lines[0], 'date,hour,hashesDeliveredEh,pctOfNominal,avgMinerHashratePhs,avgPoolHashratePhs')
  t.is(lines[1], '"01/08/2026","00:00","360","80","100","99"', '1e11 MH/s x 3600 / 1e12 = 360 EH')
  t.is(lines[3], '"01/08/2026","02:00","360","80","100","99"')
  t.is(lines.length, 4, 'header plus one row per bucket')
  t.pass()
})

test('invoicing-daily-hashes - one row per day, EH delivered over the day', async (t) => {
  const { out } = await runExport(
    'invoicing-daily-hashes',
    { start: START, end: START + 2 * DAY_MS, timezone: 'UTC', format: 'csv' },
    { buckets: 2, interval: DAY_MS }
  )
  const lines = out.split('\n')

  t.is(lines[0], 'month,day,hashesDeliveredEh,pctOfNominal,avgMinerHashratePhs,avgPoolHashratePhs')
  t.is(lines[1], '"August","01","8640","80","100","99"', '1e11 MH/s x 86400 / 1e12 = 8640 EH')
  t.is(lines[2], '"August","02","8640","80","100","99"')
  t.pass()
})

test('invoice-breakdown - one row, margin applied over energy, ops and payable amortization', async (t) => {
  const { out } = await runExport(
    'invoice-breakdown',
    { start: START, end: START + 2 * DAY_MS, timezone: 'UTC', format: 'json' },
    {
      buckets: 2,
      interval: DAY_MS,
      globalData: {
        costParameters: {
          lcoe: { effectiveUsdPerMwh: 50 },
          minerAmortizationUsd: 100000,
          infraAmortizationUsd: 50000,
          marginPct: 10
        },
        productionCosts: [{ site: 'site', year: 2026, month: 8, operationalCost: 5000 }]
      }
    }
  )
  const row = JSON.parse(out).breakdown[0]

  t.is(row.year, 2026)
  t.is(row.month, 8)
  t.is(row.energyConsumedMwh, 480, '10 MW over two daily buckets')
  t.is(row.energyCostsUsd, 24000, '480 MWh x 50 USD/MWh')
  t.is(row.operationalCostUsd, 5000, 'read from the month production costs')
  t.is(row.pctOfNominal, 80, 'range-wide delivered percentage')
  t.is(row.amortizationUsd, 150000)
  t.is(row.amortizationPayableUsd, 120000, '80% of the amortization is payable')
  t.is(row.marginUsd, 14900, '10% of energy + ops + payable amortization')
  t.is(row.monthlyInvoiceUsd, 163900)
  t.pass()
})

test('invoice-breakdown - the month is read in UTC, not in the label timezone', async (t) => {
  const globalData = {
    costParameters: { overrides: { '2026-07': { lcoe: { effectiveUsdPerMwh: 42 } }, '2026-08': { lcoe: { effectiveUsdPerMwh: 50 } } } },
    productionCosts: [{ site: 'site', year: 2026, month: 8, operationalCost: 5000 }]
  }
  const params = { start: START, end: START + 2 * DAY_MS, format: 'json' }
  const ctxOpts = { buckets: 2, interval: DAY_MS, globalData }

  const utc = JSON.parse((await runExport('invoice-breakdown', { ...params, timezone: 'UTC' }, ctxOpts)).out)
  const local = JSON.parse((await runExport('invoice-breakdown', { ...params, timezone: 'America/Sao_Paulo' }, ctxOpts)).out)

  t.alike(local.breakdown[0], utc.breakdown[0], 'a west-of-UTC label timezone bills the same month')
  t.is(local.breakdown[0].month, 8, 'the UTC month start belongs to August')
  t.is(local.breakdown[0].lcoeUsdPerMwh, 50, 'August override, not July')
  t.is(local.breakdown[0].operationalCostUsd, 5000)
  t.pass()
})

test('invoice-breakdown - a missing input nulls its dependents, never zeroes them', async (t) => {
  const { out } = await runExport(
    'invoice-breakdown',
    { start: START, end: START + 2 * DAY_MS, timezone: 'UTC', format: 'json' },
    { buckets: 2, interval: DAY_MS, globalData: { costParameters: { marginPct: 10 } } }
  )
  const row = JSON.parse(out).breakdown[0]

  t.is(row.energyConsumedMwh, 480, 'measured inputs still report')
  t.is(row.lcoeUsdPerMwh, null)
  t.is(row.energyCostsUsd, null, 'no LCOE means no energy cost, not a free month')
  t.is(row.operationalCostUsd, null, 'no saved production costs for the month')
  t.is(row.amortizationUsd, null)
  t.is(row.amortizationPayableUsd, null)
  t.is(row.marginUsd, null)
  t.is(row.monthlyInvoiceUsd, null)
  t.pass()
})
