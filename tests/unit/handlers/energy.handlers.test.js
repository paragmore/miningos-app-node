'use strict'

const test = require('brittle')
const {
  getEnergyConsumption,
  saveEnergyConsumption,
  setAvailableEnergy,
  setAvailableEnergyHistory,
  setForecastOverride,
  setForecastOverrideHistory,
  getEnergyForecastHistory
} = require('../../../workers/lib/server/handlers/energy.handlers')
const {
  RPC_METHODS,
  WORKER_TYPES,
  ELECTRICITY_EXT_DATA_KEYS
} = require('../../../workers/lib/constants')
const { withDataProxy } = require('../helpers/mockHelpers')

const OVERRIDE_BODY = {
  start: 1700000000000,
  end: 1700100000000,
  manualOverrideMine: true
}

const AVAILABLE_ENERGY_DATA = [
  { start: 1700000000000, end: 1700003600000, availableMw: 5.5 }
]

const AVAILABLE_ENERGY_HISTORY_BODY = {
  start: 1700000000000,
  end: 1700100000000,
  availableMw: 6.5
}

test('setForecastOverrideHistory - writes forecastOverrideHist with the request body', async (t) => {
  let captured = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        captured = { method, payload }
        return { success: true }
      }
    }
  })

  const result = await setForecastOverrideHistory(mockCtx, { body: OVERRIDE_BODY })

  t.is(captured.method, RPC_METHODS.SET_WRK_EXT_DATA, 'should call setWrkExtData')
  t.is(captured.payload.type, WORKER_TYPES.ELECTRICITY, 'should target the electricity worker')
  t.is(captured.payload.key, ELECTRICITY_EXT_DATA_KEYS.FORECAST_OVERRIDE_HISTORY, 'should write the history override key')
  t.alike(captured.payload.value, OVERRIDE_BODY, 'should pass the request body as the value')
  t.ok(Array.isArray(result), 'should return an array of ork results')
  t.alike(result[0], { success: true }, 'should return the ork response')
  t.pass()
})

test('setForecastOverrideHistory - maps the write to every ork', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }, { rpcPublicKey: 'key2' }] },
    net_r0: {
      jRequest: async () => ({ success: true })
    }
  })

  const result = await setForecastOverrideHistory(mockCtx, { body: OVERRIDE_BODY })

  t.is(result.length, 2, 'should return a result for each ork')
  t.pass()
})

test('setForecastOverrideHistory - uses a different key than setForecastOverride', async (t) => {
  const keys = []
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        keys.push(payload.key)
        return { success: true }
      }
    }
  })

  await setForecastOverride(mockCtx, { body: OVERRIDE_BODY })
  await setForecastOverrideHistory(mockCtx, { body: OVERRIDE_BODY })

  t.is(keys[0], ELECTRICITY_EXT_DATA_KEYS.FORECAST_OVERRIDE, 'live override uses forecastOverride')
  t.is(keys[1], ELECTRICITY_EXT_DATA_KEYS.FORECAST_OVERRIDE_HISTORY, 'history override uses forecastOverrideHistory')
  t.pass()
})

test('setAvailableEnergyHistory - writes availableEnergyHistory with the request body', async (t) => {
  let captured = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        captured = { method, payload }
        return { success: true }
      }
    }
  })

  const result = await setAvailableEnergyHistory(mockCtx, { body: AVAILABLE_ENERGY_HISTORY_BODY })

  t.is(captured.method, RPC_METHODS.SET_WRK_EXT_DATA, 'should call setWrkExtData')
  t.is(captured.payload.type, WORKER_TYPES.ELECTRICITY, 'should target the electricity worker')
  t.is(captured.payload.key, ELECTRICITY_EXT_DATA_KEYS.AVAIL_ENERGY_HISTORY, 'should write the available energy history key')
  t.alike(captured.payload.value, AVAILABLE_ENERGY_HISTORY_BODY, 'should pass the request body as the value')
  t.ok(Array.isArray(result), 'should return an array of ork results')
  t.alike(result[0], { success: true }, 'should return the ork response')
  t.pass()
})

test('setAvailableEnergyHistory - maps the write to every ork', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }, { rpcPublicKey: 'key2' }] },
    net_r0: {
      jRequest: async () => ({ success: true })
    }
  })

  const result = await setAvailableEnergyHistory(mockCtx, { body: AVAILABLE_ENERGY_HISTORY_BODY })

  t.is(result.length, 2, 'should return a result for each ork')
  t.pass()
})

test('setAvailableEnergyHistory - uses a different key than setAvailableEnergy', async (t) => {
  const keys = []
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        keys.push(payload.key)
        return { success: true }
      }
    }
  })

  await setAvailableEnergy(mockCtx, { body: { data: AVAILABLE_ENERGY_DATA } })
  await setAvailableEnergyHistory(mockCtx, { body: AVAILABLE_ENERGY_HISTORY_BODY })

  t.is(keys[0], ELECTRICITY_EXT_DATA_KEYS.AVAIL_ENERGY, 'live available energy uses availableEnergy')
  t.is(keys[1], ELECTRICITY_EXT_DATA_KEYS.AVAIL_ENERGY_HISTORY, 'history uses availableEnergyHistory')
  t.pass()
})

// ==================== Forecast history actuals ====================

const HOUR_MS = 60 * 60 * 1000
const HIST_HOUR_TS = 1700006400000

// A closed hour the forecast priced at 48 MWh of mining
const HISTORY_MINE_HOUR = {
  start: HIST_HOUR_TS,
  end: HIST_HOUR_TS + HOUR_MS,
  decision: 'mine',
  availableMw: 48,
  availableEnergy: 1,
  miningRevenue: 4800,
  miningRevenuePerMwh: 100,
  taxesAndFees: 480,
  taxesAndFeesPerMwh: 10,
  miningRevenueSelected: 4800,
  miningRevenueSelectedPerMwh: 100,
  expectedRevenue: 3840,
  expectedRevenuePerMwh: 80,
  energySalesRevenue: 500,
  energySalesRevenuePerMwh: 10.42
}

function powerRow (hourTs, powerW) {
  return { ts: `${hourTs}-${hourTs + HOUR_MS - 1}`, site_power_w: powerW }
}

function historyCtx ({ history, powerRows = [], onTailLog } = {}) {
  return withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === RPC_METHODS.GET_WRK_EXT_DATA) return history
        if (onTailLog) onTailLog(payload)
        if (powerRows instanceof Error) throw powerRows
        return powerRows
      }
    }
  })
}

test('getEnergyForecastHistory - recomputes closed mine hours from the metered consumption', async (t) => {
  let tailPayload
  const mockCtx = historyCtx({
    history: [{ revenueIfAllMine: 12345, hourlyForecast: [HISTORY_MINE_HOUR] }],
    powerRows: [powerRow(HIST_HOUR_TS, 10000000)],
    onTailLog: (payload) => { tailPayload = payload }
  })

  const result = await getEnergyForecastHistory(mockCtx, {
    query: { start: HIST_HOUR_TS, end: HIST_HOUR_TS + HOUR_MS }
  })

  t.is(tailPayload.start, HIST_HOUR_TS, 'meter tailed over the requested range')
  t.is(tailPayload.end, HIST_HOUR_TS + HOUR_MS, 'meter tailed over the requested range')
  t.ok('site_power_w' in tailPayload.fields, 'projects site power')
  t.is(tailPayload.type, 'powermeter', 'non-DCS site reads the powermeter worker')

  const hour = result[0][0].hourlyForecast[0]
  t.is(hour.actualConsumptionMwh, 10, '10 MW metered over the hour')
  t.is(hour.miningRevenue, 1000, 'per-MWh rate times the metered MWh')
  t.is(hour.taxesAndFees, 100, 'taxes follow the metered MWh')
  t.is(hour.miningRevenueSelected, 1000, 'selected revenue follows the metered MWh')
  t.is(hour.expectedRevenue, 800, 'expected revenue follows the metered MWh')
  t.is(hour.miningRevenuePerMwh, 100, 'per-MWh rates stay as stored')
  t.is(hour.energySalesRevenue, 500, 'sell side stays as stored')
  t.is(result[0][0].revenueIfAllMine, 12345, 'summary fields pass through')
  t.pass()
})

test('getEnergyForecastHistory - central DCS reads the metered power from the DCS worker', async (t) => {
  let tailPayload
  const mockCtx = historyCtx({
    history: [{ hourlyForecast: [HISTORY_MINE_HOUR] }],
    powerRows: [powerRow(HIST_HOUR_TS, 10000000)],
    onTailLog: (payload) => { tailPayload = payload }
  })
  mockCtx.conf.featureConfig = {
    ...mockCtx.conf.featureConfig,
    centralDCSSetup: { enabled: true, tag: 't-dcs-custom' }
  }

  await getEnergyForecastHistory(mockCtx, {
    query: { start: HIST_HOUR_TS, end: HIST_HOUR_TS + HOUR_MS }
  })

  t.is(tailPayload.type, 'dcs-siemens', 'tails the DCS worker type')
  t.is(tailPayload.tag, 't-dcs-custom', 'uses the configured DCS tag')
  t.pass()
})

test('getEnergyForecastHistory - leaves non-mining, open and unmetered hours on forecast values', async (t) => {
  const openStart = Math.floor((Date.now() + 24 * HOUR_MS) / HOUR_MS) * HOUR_MS
  const notMineHour = {
    ...HISTORY_MINE_HOUR,
    start: HIST_HOUR_TS + HOUR_MS,
    end: HIST_HOUR_TS + 2 * HOUR_MS,
    decision: 'not_mine'
  }
  const unmeteredHour = {
    ...HISTORY_MINE_HOUR,
    start: HIST_HOUR_TS + 2 * HOUR_MS,
    end: HIST_HOUR_TS + 3 * HOUR_MS
  }
  const openHour = { ...HISTORY_MINE_HOUR, start: openStart, end: openStart + HOUR_MS }
  const mockCtx = historyCtx({
    history: [{ hourlyForecast: [HISTORY_MINE_HOUR, notMineHour, unmeteredHour, openHour] }],
    powerRows: [
      powerRow(HIST_HOUR_TS, 5000000),
      powerRow(HIST_HOUR_TS + HOUR_MS, 5000000),
      powerRow(openStart, 5000000)
    ]
  })

  const result = await getEnergyForecastHistory(mockCtx, {
    query: { start: HIST_HOUR_TS, end: openStart + HOUR_MS }
  })

  const [mined, notMined, unmetered, open] = result[0][0].hourlyForecast
  t.is(mined.miningRevenue, 500, 'the closed metered mine hour is recomputed')
  t.alike(notMined, notMineHour, 'a not-mining hour keeps its forecast values')
  t.alike(unmetered, unmeteredHour, 'a mine hour without a meter reading keeps its forecast values')
  t.alike(open, openHour, 'an hour that has not closed yet keeps its forecast values')
  t.absent('actualConsumptionMwh' in notMined, 'no actuals marker on untouched hours')
  t.pass()
})

test('getEnergyForecastHistory - meter fetch failure serves the history on forecast values', async (t) => {
  const mockCtx = historyCtx({
    history: [{ hourlyForecast: [HISTORY_MINE_HOUR] }],
    powerRows: new Error('ERR_NO_METER')
  })

  const result = await getEnergyForecastHistory(mockCtx, {
    query: { start: HIST_HOUR_TS, end: HIST_HOUR_TS + HOUR_MS }
  })

  t.alike(result[0][0].hourlyForecast[0], HISTORY_MINE_HOUR, 'history untouched without meter data')
  t.pass()
})

const CONS_H0 = Date.UTC(2026, 0, 1)
const CONS_HOUR = 3600000

function consEntry (ts, v = 1) {
  return { ts, totalConsumptionMWh: v * 10, cduConsumptionMWh: v, rectifier1ConsumptionMWh: v * 4, rectifier2ConsumptionMWh: v * 4 }
}

function consumptionCtx ({ orks = [{ rpcPublicKey: 'key1' }], featureConfig, jRequest }) {
  return withDataProxy({ conf: { orks, ...(featureConfig && { featureConfig }) }, net_r0: { jRequest } })
}

function saveReq (entries) {
  return { body: { entries } }
}

test('getEnergyConsumption - reads the DCS consumption log, dedups by ts and sorts', async (t) => {
  const calls = []
  const ctx = consumptionCtx({
    orks: [{ rpcPublicKey: 'key1' }, { rpcPublicKey: 'key2' }],
    jRequest: async (key, method, payload) => {
      calls.push({ key, method, payload })
      if (key === 'key1') return [{ ...consEntry(CONS_H0 + CONS_HOUR), updatedAt: 1 }, { ...consEntry(CONS_H0), updatedAt: 1 }, null]
      return [{ ...consEntry(CONS_H0 + CONS_HOUR, 5), updatedAt: 2 }, undefined]
    }
  })

  const result = await getEnergyConsumption(ctx, { query: { start: CONS_H0, end: CONS_H0 + CONS_HOUR } })

  t.is(calls[0].method, RPC_METHODS.GET_HISTORICAL_LOGS)
  t.alike(calls[0].payload, { logType: 'consumption', type: WORKER_TYPES.DCS, start: CONS_H0, end: CONS_H0 + CONS_HOUR })
  t.alike(result.map(r => r.ts), [CONS_H0, CONS_H0 + CONS_HOUR], 'ascending, one per hour')
  t.is(result[1].cduConsumptionMWh, 5, 'latest updatedAt wins')
})

test('getEnergyConsumption - keeps null values as null and zeros as zeros', async (t) => {
  const ctx = consumptionCtx({
    jRequest: async () => [{ ts: CONS_H0, totalConsumptionMWh: 10, cduConsumptionMWh: null, rectifier1ConsumptionMWh: 0, updatedAt: 1 }]
  })
  const [row] = await getEnergyConsumption(ctx, { query: { start: CONS_H0, end: CONS_H0 } })
  t.is(row.cduConsumptionMWh, null, 'a cleared value is returned as null')
  t.is(row.rectifier1ConsumptionMWh, 0)
  t.ok('cduConsumptionMWh' in row)
})

test('getEnergyConsumption - throws when every ork fails', async (t) => {
  const ctx = consumptionCtx({ jRequest: async () => { throw new Error('boom') } })
  await t.exception(() => getEnergyConsumption(ctx, { query: { start: 0, end: 1 } }))
})

test('saveEnergyConsumption - sends only the entries to the DCS worker, aligned to the locked site zone', async (t) => {
  let captured = null
  const ctx = consumptionCtx({
    featureConfig: { lockedTimezone: 'Asia/Kolkata' },
    jRequest: async (key, method, payload) => {
      captured = { method, payload }
      return [{ upserted: payload.entries.length }]
    }
  })
  const entries = [consEntry(CONS_H0 + 30 * 60000), consEntry(CONS_H0 + 90 * 60000, 0)]

  const result = await saveEnergyConsumption(ctx, saveReq(entries))

  t.alike(result, { success: true, upserted: 2 })
  t.is(captured.method, RPC_METHODS.SAVE_HISTORICAL_LOG)
  t.alike(captured.payload, {
    logType: 'consumption',
    type: WORKER_TYPES.DCS,
    entries
  })
})

test('saveEnergyConsumption - clears the cached consumption metrics only after a confirmed write', async (t) => {
  const LRU = require('lru')
  const cache = new LRU({ max: 100 })
  const okCtx = consumptionCtx({ jRequest: async (key, method, payload) => [{ upserted: payload.entries.length }] })
  okCtx.lru_30s = { cache }
  okCtx.conf.cacheTiming = {}
  cache.set('metrics/consumption:phase-1:1:2:-:-:-:-', { stale: true })
  cache.set('metrics/efficiency:phase-1', 1)

  await saveEnergyConsumption(okCtx, saveReq([consEntry(CONS_H0)]))

  t.alike(cache.keys, ['metrics/efficiency:phase-1'], 'consumption entries dropped, other routes kept')

  const failCtx = consumptionCtx({ jRequest: async () => [] })
  failCtx.lru_30s = { cache }
  failCtx.conf.cacheTiming = {}
  cache.set('metrics/consumption:phase-1:1:2:-:-:-:-', { stale: true })
  await t.exception(() => saveEnergyConsumption(failCtx, saveReq([consEntry(CONS_H0)])), /ERR_CONSUMPTION_SAVE_FAILED/)
  t.ok(cache.peek('metrics/consumption:phase-1:1:2:-:-:-:-'), 'kept when nothing was written')
})

test('saveEnergyConsumption - forwards partial entries, zeros and nulls untouched', async (t) => {
  let captured = null
  const ctx = consumptionCtx({
    jRequest: async (key, method, payload) => { captured = payload; return [{ upserted: payload.entries.length }] }
  })
  const entries = [
    { ts: CONS_H0, cduConsumptionMWh: 0 },
    { ts: CONS_H0 + CONS_HOUR, totalConsumptionMWh: null, rectifier1ConsumptionMWh: 2.5 }
  ]

  t.alike(await saveEnergyConsumption(ctx, saveReq(entries)), { success: true, upserted: 2 })
  t.alike(captured.entries, entries, 'merge/clear semantics are the worker\'s: nothing is filled in or dropped here')
})

test('saveEnergyConsumption - rejects hours off the site grid before any rpc', async (t) => {
  let rpcCalls = 0
  const jRequest = async () => { rpcCalls++; return [{ upserted: 1 }] }

  const kolkata = consumptionCtx({ featureConfig: { lockedTimezone: 'Asia/Kolkata' }, jRequest })
  await t.exception(() => saveEnergyConsumption(kolkata, saveReq([consEntry(CONS_H0)])), /ERR_TS_NOT_HOUR_ALIGNED/, 'whole UTC hour is :30 local in +5:30')

  const utc = consumptionCtx({ jRequest })
  await t.exception(() => saveEnergyConsumption(utc, saveReq([consEntry(CONS_H0 + 500)])), /ERR_TS_NOT_HOUR_ALIGNED/)
  await t.exception(() => saveEnergyConsumption(utc, saveReq([consEntry(CONS_H0), consEntry(CONS_H0, 2)])), /ERR_TS_DUPLICATE/)

  t.is(rpcCalls, 0)
})

test('saveEnergyConsumption - works without a configured zone and never sends one to the worker', async (t) => {
  let captured = null
  const ctx = consumptionCtx({
    featureConfig: { lockedTimezone: undefined },
    jRequest: async (key, method, payload) => { captured = payload; return [{ upserted: 1 }] }
  })
  // LOCKED_TIMEZONE_DEFAULT shares the whole-UTC-hour grid
  await saveEnergyConsumption(ctx, saveReq([consEntry(CONS_H0)]))
  t.absent('timezone' in captured, 'timezone is not part of the worker payload')
  t.absent('user' in captured)
})

test('saveEnergyConsumption - fails loudly when no rack confirms the write', async (t) => {
  const entries = [consEntry(CONS_H0)]
  const cases = [
    ['no DCS rack / rack rejected (ork returns [])', async () => []],
    ['old ork without saveHistoricalLog', async () => { throw new Error('UNKNOWN_METHOD') }],
    ['old DCS worker (base no-op)', async () => [undefined]],
    ['partial write count', async () => [{ upserted: 0 }]]
  ]
  for (const [name, jRequest] of cases) {
    const ctx = consumptionCtx({ jRequest })
    await t.exception(() => saveEnergyConsumption(ctx, saveReq(entries)), /ERR_CONSUMPTION_SAVE_FAILED/, name)
  }
})

test('saveEnergyConsumption - succeeds when one ork confirms and another errors', async (t) => {
  const ctx = consumptionCtx({
    orks: [{ rpcPublicKey: 'key1' }, { rpcPublicKey: 'key2' }],
    jRequest: async (key) => {
      if (key === 'key2') throw new Error('ork down')
      return [{ upserted: 1 }]
    }
  })
  const origError = console.error
  const logged = []
  console.error = (...args) => logged.push(args)
  t.teardown(() => { console.error = origError })

  t.alike(await saveEnergyConsumption(ctx, saveReq([consEntry(CONS_H0)])), { success: true, upserted: 1 })
  t.ok(logged.some(args => args.includes('ERR_CONSUMPTION_SAVE_ORK')), 'ork failure is logged, not swallowed')
})
