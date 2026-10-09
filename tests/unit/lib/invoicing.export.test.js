'use strict'

const test = require('brittle')
const { getExportType, resolveExport, EXPORT_TYPES } = require('../../../workers/lib/server/lib/export/registry')
const { withDataProxy } = require('../helpers/mockHelpers')
const { rollupLocalDays } = require('../../../workers/lib/metrics.utils')

const HOUR_MS = 3600000
const DAY_MS = 24 * HOUR_MS
const START = Date.UTC(2026, 7, 1)
const MHS = 1e11
const NOMINAL_MHS = 1.25e11
const POOL_HS = 9.9e16 // 99 PH/s, pool stats are in H/s

function mockCtx ({ buckets = 3, interval = HOUR_MS, globalData = {}, hashrateMhs = MHS, poolHashrateHs = POOL_HS, poolBuckets = null, siteNominalMhs } = {}) {
  return withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    globalDataLib: { getGlobalData: async ({ type }) => globalData[type] },
    net_r0: {
      jRequest: async (key, method, params) => {
        if (method === 'getGlobalConfig') return { nominalSiteHashrate_MHS: siteNominalMhs }
        if (method === 'getWrkExtData') {
          return [{
            hashrateHistory: poolHashrateHs === null
              ? []
              : Array.from({ length: poolBuckets ?? buckets }, (_, i) => ({
                poolType: 'f2pool',
                ts: START + i * interval + 1000,
                username: 'account-a',
                hashrate: poolHashrateHs
              }))
          }]
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
  for (const type of ['invoicing-hourly-hashes', 'invoicing-daily-hashes', 'invoicing-monthly-hashes', 'invoice-breakdown']) {
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

test('invoicing exports round % of nominal to two decimals and every other figure to three', async (t) => {
  const { out } = await runExport(
    'invoicing-hourly-hashes',
    { start: START, end: START + HOUR_MS, timezone: 'UTC', format: 'csv' },
    { buckets: 1, hashrateMhs: 123456789012.3, poolHashrateHs: 9.87654e16 }
  )

  t.is(out.split('\n')[1], '"01/08/2026","00:00","355.555","79.01","123.457","98.765"')
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
  t.is(lines[1], '"01/08/2026","00:00","356.4","79.2","100","99"', 'pool 9.9e10 MH/s x 3600 / 1e12 = 356.4 EH')
  t.is(lines[3], '"01/08/2026","02:00","356.4","79.2","100","99"')
  t.is(lines.length, 4, 'header plus one row per bucket')
  t.pass()
})

test('invoicing-daily-hashes - one row per UTC day when the export is asked for UTC', async (t) => {
  const { out } = await runExport(
    'invoicing-daily-hashes',
    { start: START, end: START + 2 * DAY_MS, timezone: 'UTC', format: 'csv' },
    { buckets: 48, interval: HOUR_MS }
  )
  const lines = out.split('\n')

  t.is(lines[0], 'month,day,hashesDeliveredEh,pctOfNominal,avgMinerHashratePhs,avgPoolHashratePhs')
  t.is(lines[1], '"August","01","8553.6","79.2","100","99"', 'pool 9.9e10 MH/s x 86400 / 1e12 = 8553.6 EH')
  t.is(lines[2], '"August","02","8553.6","79.2","100","99"')
  t.is(lines.length, 3, 'header plus one row per day')
  t.pass()
})

test('invoicing-daily-hashes - hourly buckets roll up into the requested timezone days', async (t) => {
  const { out } = await runExport(
    'invoicing-daily-hashes',
    { start: START, end: START + 2 * DAY_MS, timezone: 'America/Sao_Paulo', format: 'csv' },
    { buckets: 48, interval: HOUR_MS }
  )
  const lines = out.split('\n')

  t.is(lines[1], '"July","31","1069.2","79.2","100","99"', 'the 3 hours before Aug 1 00:00 UTC are still July 31 locally')
  t.is(lines[2], '"August","01","8553.6","79.2","100","99"', 'a full local day')
  t.is(lines[3], '"August","02","7484.4","79.2","100","99"', 'the 21 hours the range reaches into Aug 2 locally')
  t.is(lines.length, 4, 'a UTC-aligned 2-day range spans 3 local days')
  t.pass()
})

test('invoicing-daily-hashes - a day the pool never reported delivers null, not zero', async (t) => {
  const { out } = await runExport(
    'invoicing-daily-hashes',
    { start: START, end: START + DAY_MS, timezone: 'UTC', format: 'json' },
    { buckets: 24, interval: HOUR_MS, poolHashrateHs: null }
  )
  const row = JSON.parse(out).hashes[0]

  t.is(row.hashesDeliveredEh, null, 'no pool samples is missing data, not lost hashes')
  t.is(row.avgPoolHashratePhs, null)
  t.is(row.avgMinerHashratePhs, 100, 'miner telemetry still reports')
  t.is(row.pctOfNominal, null, 'no pool samples means no delivered share either')
  t.pass()
})

test('invoicing-monthly-hashes - one row per UTC month when the export is asked for UTC', async (t) => {
  const { filename, out } = await runExport(
    'invoicing-monthly-hashes',
    { start: START, end: START + 2 * DAY_MS, timezone: 'UTC', format: 'csv' },
    { buckets: 48, interval: HOUR_MS }
  )
  const lines = out.split('\n')

  t.ok(filename.startsWith('invoicing_monthly_hashes_'), 'filename names the export')
  t.is(lines[0], 'year,month,hashesDeliveredEh,pctOfNominal,avgMinerHashratePhs,avgPoolHashratePhs')
  t.is(lines[1], '"2026","August","17107.2","79.2","100","99"', 'pool 9.9e10 MH/s x 48 x 3600 / 1e12 = 17107.2 EH')
  t.is(lines.length, 2, 'header plus the single month the range covers')
  t.pass()
})

test('invoicing-monthly-hashes - hourly buckets roll up into the requested timezone months', async (t) => {
  const { out } = await runExport(
    'invoicing-monthly-hashes',
    { start: START, end: START + 2 * DAY_MS, timezone: 'Etc/GMT+3', format: 'csv' },
    { buckets: 48, interval: HOUR_MS }
  )
  const lines = out.split('\n')

  t.is(lines[1], '"2026","July","1069.2","79.2","100","99"', 'the 3 hours before Aug 1 00:00 UTC are still July locally')
  t.is(lines[2], '"2026","August","16038","79.2","100","99"', 'the remaining 45 hours land in August')
  t.is(lines.length, 3, 'a range opening on a UTC month boundary spans 2 local months')
  t.pass()
})

test('invoicing-monthly-hashes - a month the pool never reported delivers null, not zero', async (t) => {
  const { out } = await runExport(
    'invoicing-monthly-hashes',
    { start: START, end: START + DAY_MS, timezone: 'UTC', format: 'json' },
    { buckets: 24, interval: HOUR_MS, poolHashrateHs: null }
  )
  const row = JSON.parse(out).hashes[0]

  t.is(row.hashesDeliveredEh, null, 'no pool samples is missing data, not lost hashes')
  t.is(row.avgPoolHashratePhs, null)
  t.is(row.avgMinerHashratePhs, 100, 'miner telemetry still reports')
  t.is(row.pctOfNominal, null, 'no pool samples means no delivered share either')
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
  t.is(row.pctOfNominal, 79.2, 'pool vs nominal over the month, not the miner summary')
  t.is(row.amortizationUsd, 150000)
  t.is(row.amortizationPayableUsd, 118800, '79.2% of the amortization is payable')
  t.is(row.marginUsd, 14780, '10% of energy + ops + payable amortization')
  t.is(row.monthlyInvoiceUsd, 162580)
  t.pass()
})

test('invoice-breakdown - hours without pool data count as zero delivered, not dropped', async (t) => {
  // 4 hourly buckets, pool samples only in the first 2: the invoice bills the whole
  // period, so the share halves instead of staying at the covered-hours 79.2%.
  const { out } = await runExport(
    'invoice-breakdown',
    { start: START, end: START + 4 * HOUR_MS, timezone: 'UTC', format: 'json' },
    {
      buckets: 4,
      interval: HOUR_MS,
      poolBuckets: 2,
      globalData: {
        costParameters: { minerAmortizationUsd: 100000, infraAmortizationUsd: 50000 },
        productionCosts: []
      }
    }
  )
  const row = JSON.parse(out).breakdown[0]

  t.is(row.pctOfNominal, 39.6, 'half the coverage-basis 79.2%: 2 of 4 nominal hours delivered')
  t.is(row.amortizationPayableUsd, 59400, '39.6% of the amortization is payable')
  t.pass()
})

test('invoice-breakdown - a month the pool never reported has a null share, not zero', async (t) => {
  const { out } = await runExport(
    'invoice-breakdown',
    { start: START, end: START + 2 * DAY_MS, timezone: 'UTC', format: 'json' },
    {
      buckets: 2,
      interval: DAY_MS,
      poolHashrateHs: null,
      globalData: {
        costParameters: { minerAmortizationUsd: 100000, infraAmortizationUsd: 50000 },
        productionCosts: []
      }
    }
  )
  const row = JSON.parse(out).breakdown[0]

  t.is(row.pctOfNominal, null, 'a missing pool feed is not zero production')
  t.is(row.amortizationPayableUsd, null, 'payable amortization cannot be derived without a share')
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

test('invoice-breakdown - localMonth bills the requested timezone month from hourly buckets', async (t) => {
  const globalData = {
    costParameters: { overrides: { '2026-07': { lcoe: { effectiveUsdPerMwh: 42 } }, '2026-08': { lcoe: { effectiveUsdPerMwh: 50 } } } },
    productionCosts: [{ site: 'site', year: 2026, month: 8, operationalCost: 5000 }]
  }
  // Local August in Sao Paulo starts at 03:00 UTC on the 1st
  const start = START + 3 * HOUR_MS
  const { out } = await runExport(
    'invoice-breakdown',
    { start, end: start + 2 * DAY_MS, timezone: 'America/Sao_Paulo', format: 'json', localMonth: 'true' },
    { buckets: 48, interval: HOUR_MS, globalData }
  )
  const row = JSON.parse(out).breakdown[0]

  t.is(row.month, 8, 'the local month start belongs to August')
  t.is(row.lcoeUsdPerMwh, 50, 'August override, not July')
  t.is(row.operationalCostUsd, 5000)
  t.is(row.energyConsumedMwh, 480, '10 MW over 48 hourly buckets, each an hour long')
  t.is(row.pctOfNominal, 79.2, 'pool vs nominal over the hourly buckets')
  t.pass()
})

test('invoicing exports measure % of nominal against the configured site nominal', async (t) => {
  const params = { start: START, end: START + 2 * DAY_MS, timezone: 'UTC', format: 'json', localMonth: 'true' }
  const ctxOpts = { buckets: 48, interval: HOUR_MS, siteNominalMhs: 1.5e11 }

  const { out: breakdown } = await runExport('invoice-breakdown', params, ctxOpts)
  t.is(JSON.parse(breakdown).breakdown[0].pctOfNominal, 66, '99 PH/s pool vs the 150 PH/s site nominal, not the 125 PH/s installed')

  const { out: hourly } = await runExport('invoicing-hourly-hashes', params, ctxOpts)
  t.is(JSON.parse(hourly).hashes[0].pctOfNominal, 66)

  const { out: unset } = await runExport('invoice-breakdown', params, { buckets: 48, interval: HOUR_MS })
  t.is(JSON.parse(unset).breakdown[0].pctOfNominal, 79.2, 'falls back to the installed nominal when the site nominal is not configured')
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

test('rollupLocalDays - a non-finite miner value is left out of the day mean, not counted as zero', async (t) => {
  const [day] = rollupLocalDays([
    { ts: START, hashrateMhs: 100, nominalHashrateMhs: 200, poolHashrateMhs: 100 },
    { ts: START + HOUR_MS, hashrateMhs: null, nominalHashrateMhs: 200, poolHashrateMhs: null },
    { ts: START + 2 * HOUR_MS, hashrateMhs: 300, nominalHashrateMhs: 200, poolHashrateMhs: 200 }
  ], 'UTC')

  t.is(day.hashrateMhs, 200, 'mean of the two finite miner samples')
  t.is(day.poolHashrateMhs, 150)
  t.is(day.pctOfNominal, 75, 'summed pool over summed nominal of the hours carrying both')
  t.is(day.poolSeconds, 7200)

  const [empty] = rollupLocalDays([{ ts: START, hashrateMhs: null, nominalHashrateMhs: 0, poolHashrateMhs: null }], 'UTC')
  t.is(empty.hashrateMhs, null, 'no finite miner sample is null, not NaN')
  t.is(empty.pctOfNominal, null)
  t.pass()
})
