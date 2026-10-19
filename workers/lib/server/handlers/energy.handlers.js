'use strict'

const {
  WORKER_TYPES,
  WORKER_TAGS,
  RPC_METHODS,
  ELECTRICITY_EXT_DATA_KEYS,
  LOG_FIELDS,
  AGGR_FIELDS,
  HISTORICAL_LOG_TYPES,
  LOCKED_TIMEZONE_DEFAULT,
  ENDPOINTS
} = require('../../constants')
const { clearCachedRoute } = require('../lib/cachedRoute')
const { clearPhaseHourlyCache } = require('../lib/phaseConsumptionCache')
const { isCentralDCSEnabled, getDCSTag } = require('../../dcs.utils')
const { getIntervalConfig, parseEntryTs, assertTimezone } = require('../../metrics.utils')
const { isLocalHourStart } = require('../../period.utils')

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

// Hourly consumption hours are aligned to the site's configured zone. It is
// deliberately not overridable per request, so every write lands on one grid.
const getSiteTimezone = (ctx) =>
  assertTimezone(ctx.conf?.featureConfig?.lockedTimezone || LOCKED_TIMEZONE_DEFAULT)

// Records for [start, end] from the DCS worker's consumption log, ascending by ts.
// The same hour can come back from several orks/racks; the latest write wins.
const getEnergyConsumption = async (ctx, req) => {
  const { start, end } = req.query
  const results = await ctx.dataProxy.requestDataMap(
    RPC_METHODS.GET_HISTORICAL_LOGS,
    { logType: HISTORICAL_LOG_TYPES.CONSUMPTION, type: WORKER_TYPES.DCS, start, end }
  )

  const byTs = new Map()
  for (const orkResult of results) {
    for (const entry of Array.isArray(orkResult) ? orkResult : [orkResult]) {
      if (!entry || !Number.isFinite(entry.ts)) continue
      const prev = byTs.get(entry.ts)
      if (!prev || (entry.updatedAt || 0) > (prev.updatedAt || 0)) byTs.set(entry.ts, entry)
    }
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts)
}

// Patches hourly consumption on the DCS worker: each entry replaces only the values
// it passes (zeros included) and null clears one (it reads back as null), so a partial entry never wipes
// the rest of the hour. Validated here first: the ork drops rack errors (a rejected
// write comes back as an empty result), so success is only reported when a rack
// confirms the write. The consumption metrics read the manual phase groups from this
// log, so their cached responses are dropped once the write lands.
const saveEnergyConsumption = async (ctx, req) => {
  const { entries } = req.body
  const timezone = getSiteTimezone(ctx)

  const seen = new Set()
  for (const { ts } of entries) {
    if (!isLocalHourStart(ts, timezone)) throw new Error('ERR_TS_NOT_HOUR_ALIGNED')
    if (seen.has(ts)) throw new Error('ERR_TS_DUPLICATE')
    seen.add(ts)
  }

  const results = await ctx.dataProxy.requestData(RPC_METHODS.SAVE_HISTORICAL_LOG, {
    logType: HISTORICAL_LOG_TYPES.CONSUMPTION,
    type: WORKER_TYPES.DCS,
    entries
  })

  let written = false
  for (const orkResult of results) {
    if (orkResult?.error) {
      console.error(new Date().toISOString(), 'ERR_CONSUMPTION_SAVE_ORK', orkResult.error)
      continue
    }
    if (Array.isArray(orkResult) && orkResult.some(r => r?.upserted === entries.length)) written = true
  }
  if (!written) throw new Error('ERR_CONSUMPTION_SAVE_FAILED')

  clearCachedRoute(ctx, ENDPOINTS.METRICS_CONSUMPTION, 'metrics/consumption')
  clearPhaseHourlyCache()

  return { success: true, upserted: entries.length }
}

module.exports = {
  getEnergyConsumption,
  saveEnergyConsumption,
  getEnergyForecast,
  setAvailableEnergy,
  setAvailableEnergyHistory,
  getEnergyForecastHistory,
  setForecastSettings,
  getForecastSettings,
  setForecastOverride,
  setForecastOverrideHistory
}
