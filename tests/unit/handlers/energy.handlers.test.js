'use strict'

const test = require('brittle')
const {
  setAvailableEnergy,
  setAvailableEnergyHistory,
  setForecastOverride,
  setForecastOverrideHistory
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
