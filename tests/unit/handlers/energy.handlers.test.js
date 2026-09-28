'use strict'

const test = require('brittle')
const {
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
