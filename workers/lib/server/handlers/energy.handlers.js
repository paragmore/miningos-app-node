'use strict'

const {
  WORKER_TYPES,
  WORKER_TAGS,
  RPC_METHODS,
  ELECTRICITY_EXT_DATA_KEYS,
  LOG_FIELDS,
  AGGR_FIELDS
} = require('../../constants')
const { isCentralDCSEnabled, getDCSTag } = require('../../dcs.utils')
const { getIntervalConfig, parseEntryTs } = require('../../metrics.utils')

const HOUR_MS = 60 * 60 * 1000

const round2 = (value) => Math.round(value * 100) / 100

const getEnergyForecast = async (ctx, req) => {
  return await ctx.dataProxy.requestDataMap(
    RPC_METHODS.GET_WRK_EXT_DATA,
    {
      type: WORKER_TYPES.ELECTRICITY,
      query: { key: ELECTRICITY_EXT_DATA_KEYS.FORECAST }
    })
}

// Hourly metered site power keyed by hour start, from the same source the
// downtime report reads: the DCS worker when central DCS is on, else the
// powermeter worker.
const fetchMeteredPowerByHour = async (ctx, start, end) => {
  const { key, groupRange } = getIntervalConfig('1h')
  const requestParams = isCentralDCSEnabled(ctx)
    ? { type: WORKER_TYPES.DCS, tag: getDCSTag(ctx) }
    : { type: WORKER_TYPES.POWERMETER, tag: WORKER_TAGS.POWERMETER }

  const res = await ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, {
    ...requestParams,
    key,
    groupRange,
    shouldCalculateAvg: true,
    start,
    end,
    fields: { [LOG_FIELDS.SITE_POWER]: 1 },
    aggrFields: { [AGGR_FIELDS.SITE_POWER]: 1 }
  })

  const byHour = new Map()
  for (const entry of Array.isArray(res?.[0]) ? res[0] : []) {
    const ts = parseEntryTs(entry.ts)
    const powerW = Number(entry[AGGR_FIELDS.SITE_POWER])
    if (!Number.isFinite(ts) || !Number.isFinite(powerW)) continue
    byHour.set(Math.floor(ts / HOUR_MS) * HOUR_MS, powerW)
  }
  return byHour
}

// [stored hour field, its stored per-MWh rate] pairs — every mining revenue
// figure the worker stores is linear in the mined MWh, so the actual figure is
// the same formula fed with the metered consumption instead of the assumption.
const METERED_REVENUE_FIELDS = [
  ['miningRevenue', 'miningRevenuePerMwh'],
  ['taxesAndFees', 'taxesAndFeesPerMwh'],
  ['miningRevenueSelected', 'miningRevenueSelectedPerMwh'],
  ['expectedRevenue', 'expectedRevenuePerMwh']
]

// A closed mining hour's stored revenue reflects the energy the forecast
// assumed the site would consume; recompute it from what the meter actually
// read. Sell-side figures stay as stored (settled on the declared production,
// not the site's draw), as do hours that were not mining or are still open.
const applyMeteredConsumption = (hour, powerByHour, now) => {
  if (hour?.decision !== 'mine') return hour
  if (!Number.isFinite(hour.end) || hour.end > now) return hour

  const powerW = powerByHour.get(Math.floor(hour.start / HOUR_MS) * HOUR_MS)
  if (powerW === undefined) return hour

  const meteredMwh = powerW / 1e6
  const scaled = { ...hour, actualConsumptionMwh: round2(meteredMwh) }
  for (const [field, perMwhField] of METERED_REVENUE_FIELDS) {
    if (Number.isFinite(hour[perMwhField])) {
      scaled[field] = round2(hour[perMwhField] * meteredMwh)
    }
  }
  return scaled
}

const withMeteredHistoryRevenue = async (ctx, results, start, end) => {
  if (!Array.isArray(results)) return results

  let powerByHour
  try {
    powerByHour = await fetchMeteredPowerByHour(ctx, start, end)
  } catch (e) {
    // a site without a reachable meter still gets its history, on forecast values
    return results
  }
  if (!powerByHour.size) return results

  const now = Date.now()
  const mapPayload = (payload) => Array.isArray(payload?.hourlyForecast)
    ? {
        ...payload,
        hourlyForecast: payload.hourlyForecast.map(
          (hour) => applyMeteredConsumption(hour, powerByHour, now)
        )
      }
    : payload

  return results.map((orkResult) => Array.isArray(orkResult)
    ? orkResult.map(mapPayload)
    : mapPayload(orkResult))
}

const getEnergyForecastHistory = async (ctx, req) => {
  const { start, end } = req.query
  const results = await ctx.dataProxy.requestDataMap(
    RPC_METHODS.GET_WRK_EXT_DATA,
    {
      type: WORKER_TYPES.ELECTRICITY,
      query: { key: ELECTRICITY_EXT_DATA_KEYS.FORECAST_HISTORY },
      start,
      end
    })
  return await withMeteredHistoryRevenue(ctx, results, start, end)
}

const setAvailableEnergy = async (ctx, req) => {
  return await ctx.dataProxy.requestDataMap(
    RPC_METHODS.SET_WRK_EXT_DATA,
    {
      type: WORKER_TYPES.ELECTRICITY,
      key: ELECTRICITY_EXT_DATA_KEYS.AVAIL_ENERGY,
      value: req.body.data
    })
}

const setAvailableEnergyHistory = async (ctx, req) => {
  return await ctx.dataProxy.requestDataMap(
    RPC_METHODS.SET_WRK_EXT_DATA,
    {
      type: WORKER_TYPES.ELECTRICITY,
      key: ELECTRICITY_EXT_DATA_KEYS.AVAIL_ENERGY_HISTORY,
      value: req.body
    })
}

const getForecastSettings = async (ctx, req) => {
  return await ctx.dataProxy.requestDataMap(
    RPC_METHODS.GET_WRK_EXT_DATA,
    {
      type: WORKER_TYPES.ELECTRICITY,
      query: { key: ELECTRICITY_EXT_DATA_KEYS.FORECAST_SETTINGS }
    })
}

const setForecastSettings = async (ctx, req) => {
  return await ctx.dataProxy.requestDataMap(
    RPC_METHODS.SET_WRK_EXT_DATA,
    {
      type: WORKER_TYPES.ELECTRICITY,
      key: ELECTRICITY_EXT_DATA_KEYS.FORECAST_SETTINGS,
      value: req.body
    })
}

const setForecastOverride = async (ctx, req) => {
  return await ctx.dataProxy.requestDataMap(
    RPC_METHODS.SET_WRK_EXT_DATA,
    {
      type: WORKER_TYPES.ELECTRICITY,
      key: ELECTRICITY_EXT_DATA_KEYS.FORECAST_OVERRIDE,
      value: req.body
    })
}

const setForecastOverrideHistory = async (ctx, req) => {
  return await ctx.dataProxy.requestDataMap(
    RPC_METHODS.SET_WRK_EXT_DATA,
    {
      type: WORKER_TYPES.ELECTRICITY,
      key: ELECTRICITY_EXT_DATA_KEYS.FORECAST_OVERRIDE_HISTORY,
      value: req.body
    })
}

module.exports = {
  getEnergyForecast,
  setAvailableEnergy,
  setAvailableEnergyHistory,
  getEnergyForecastHistory,
  setForecastSettings,
  getForecastSettings,
  setForecastOverride,
  setForecastOverrideHistory
}
