'use strict'

const test = require('brittle')
const {
  getCooling,
  processCoolingData,
  calculateCoolingSummary
} = require('../../../workers/lib/server/handlers/metrics.handlers')

const rtdResults = () => ([
  [
    {
      ts: 1000,
      miner_supply_temp_c: 37.2,
      miner_return_temp_c: 47.1,
      miner_flow_m3h: 384,
      system_pressure_bar: 2.8,
      hvac_supply_temp_c: 7.1,
      hvac_return_temp_c: 14.2,
      chiller_running: 1,
      towers_running: 2,
      pumps_running: 7
    },
    {
      ts: 2000,
      miner_supply_temp_c: 37.8,
      miner_return_temp_c: 47.5,
      miner_flow_m3h: 380,
      system_pressure_bar: 2.9,
      hvac_supply_temp_c: 7.3,
      hvac_return_temp_c: 14.0,
      chiller_running: 0.5,
      towers_running: 2,
      pumps_running: 6
    }
  ]
])

test('BE-10 - processCoolingData shapes log rows with delta-t and uptime', (t) => {
  const log = processCoolingData(rtdResults(), null)

  t.is(log.length, 2, 'two time points')
  t.is(log[0].ts, 1000, 'sorted by ts')
  t.is(log[0].minerSupplyTempC, 37.2, 'supply temp')
  t.is(log[0].minerDeltaTC, 9.9, 'delta-t = return - supply')
  t.is(log[0].chillerUptimePct, 100, 'chiller_running 1 -> 100%')
  t.is(log[1].chillerUptimePct, 50, 'chiller_running 0.5 -> 50%')
  t.pass()
})

test('BE-10 - calculateCoolingSummary averages present values', (t) => {
  const log = processCoolingData(rtdResults(), null)
  const summary = calculateCoolingSummary(log)

  t.is(summary.avgMinerSupplyTempC, 37.5, 'avg supply temp')
  t.is(summary.chillerUptimePct, 75, 'avg chiller uptime')
  t.ok(summary.avgMinerDeltaTC != null, 'has avg delta-t')
  t.pass()
})

test('BE-10 - getCooling returns { interval, log, summary }', async (t) => {
  const ctx = {
    conf: { featureConfig: { centralDCSSetup: { enabled: true, tag: 't-dcs' } } },
    dataProxy: { requestData: async () => rtdResults() }
  }
  const res = await getCooling(ctx, { query: { start: 1000, end: 2000, interval: 'hourly' } })

  t.ok(res.log.length === 2, 'has log')
  t.ok(res.summary, 'has summary')
  t.is(res.interval, '1h', 'hourly alias mapped to 1h')
  t.pass()
})

test('BE-10 - getCooling throws when central DCS disabled', async (t) => {
  const ctx = {
    conf: { featureConfig: { centralDCSSetup: { enabled: false } } },
    dataProxy: { requestData: async () => [] }
  }
  try {
    await getCooling(ctx, { query: { start: 1000, end: 2000 } })
    t.fail('should throw')
  } catch (err) {
    t.is(err.message, 'ERR_FEATURE_NOT_ENABLED')
  }
  t.pass()
})

test('BE-10 - getCooling validates start/end', async (t) => {
  const ctx = {
    conf: { featureConfig: { centralDCSSetup: { enabled: true, tag: 't-dcs' } } },
    dataProxy: { requestData: async () => [] }
  }
  try {
    await getCooling(ctx, { query: {} })
    t.fail('should throw')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_START_END')
  }
  t.pass()
})

test('processCoolingData - exposes the aggregation window as timeRange', (t) => {
  const results = [[{
    ts: '1770854400000-1771459199999',
    miner_supply_temp_c: 30,
    miner_return_temp_c: 40
  }]]

  const log = processCoolingData(results, '1D')

  t.is(log[0].ts, 1770854400000, 'ts should be the numeric range start')
  t.alike(log[0].timeRange, { startTs: 1770854400000, endTs: 1771459199999 }, 'timeRange should cover the full window')
  t.pass()
})
