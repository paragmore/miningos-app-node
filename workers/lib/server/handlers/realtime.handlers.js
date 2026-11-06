'use strict'

const {
  WORKER_TYPES,
  RPC_METHODS,
  LOG_KEYS,
  MINERPOOL_EXT_DATA_KEYS,
  REALTIME_CHARTS
} = require('../../constants')
const { isCentralDCSEnabled, getDCSTag } = require('../../dcs.utils')
const { parseEntryTs } = require('../../metrics.utils')
const { RealtimeSeries } = require('../lib/realtimeSeries')

const WINDOW_FIELDS = ['site_power_w_avg', 'site_power_w_min', 'site_power_w_max']

function sumWindowValues (values) {
  if (!Array.isArray(values)) return Number.isFinite(values) ? values : null
  const nums = values.filter(Number.isFinite)
  return nums.length ? nums.reduce((acc, val) => acc + val, 0) : null
}

function toConsumptionWindows (res) {
  const orkRows = Array.isArray(res?.[0]) ? res[0] : []

  return orkRows
    .map(row => {
      const avg = sumWindowValues(row.site_power_w_avg)
      return {
        ts: parseEntryTs(row.ts),
        avg,
        min: avg === null ? null : sumWindowValues(row.site_power_w_min),
        max: avg === null ? null : sumWindowValues(row.site_power_w_max)
      }
    })
    .filter(row => Number.isFinite(row.ts))
    .sort((a, b) => a.ts - b.ts)
}

function toPoolHashrateMinutes (res) {
  const byTs = new Map()

  for (const orkRows of res || []) {
    if (!Array.isArray(orkRows)) continue
    for (const row of orkRows) {
      const ts = Number(row?.ts)
      if (!Number.isFinite(ts) || !Array.isArray(row.stats)) continue
      const stats = byTs.get(ts) || []
      byTs.set(ts, stats.concat(row.stats))
    }
  }

  return [...byTs.entries()]
    .sort(([a], [b]) => a - b)
    .map(([ts, stats]) => {
      const accounts = stats.filter(stat => stat?.poolType === REALTIME_CHARTS.POOL_TYPE)
      const complete = accounts.length && accounts.every(stat => Number.isFinite(stat.hashrate))
      return {
        ts,
        hashrate: complete ? accounts.reduce((acc, stat) => acc + stat.hashrate, 0) : null
      }
    })
}

function getSeries (ctx, name, create) {
  if (!ctx._realtimeSeries) ctx._realtimeSeries = {}
  if (!ctx._realtimeSeries[name]) ctx._realtimeSeries[name] = create()
  return ctx._realtimeSeries[name]
}

function consumptionSeries (ctx) {
  const { WINDOW_MS, RETENTION_MS, CONSUMPTION_REFRESH_MS, CONSUMPTION_CHUNK_MS } = REALTIME_CHARTS

  return getSeries(ctx, 'consumption', () => new RealtimeSeries({
    retentionMs: RETENTION_MS,
    refreshMs: CONSUMPTION_REFRESH_MS,
    chunkMs: CONSUMPTION_CHUNK_MS,
    fetch: async (start, end) => toConsumptionWindows(
      await ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, {
        type: WORKER_TYPES.DCS,
        tag: getDCSTag(ctx),
        key: LOG_KEYS.POWER_10S,
        start,
        end,
        limit: Math.ceil((end - start) / WINDOW_MS) + 2,
        fields: Object.fromEntries(WINDOW_FIELDS.map(field => [field, 1])),
        aggrFields: Object.fromEntries(WINDOW_FIELDS.map(field => [field, 1]))
      })
    )
  }))
}

function poolHashrateSeries (ctx) {
  const { RETENTION_MS, HASHRATE_REFRESH_MS, HASHRATE_CHUNK_MS, HASHRATE_REFETCH_MS } = REALTIME_CHARTS

  return getSeries(ctx, 'poolHashrate', () => new RealtimeSeries({
    retentionMs: RETENTION_MS,
    refreshMs: HASHRATE_REFRESH_MS,
    chunkMs: HASHRATE_CHUNK_MS,
    refetchMs: HASHRATE_REFETCH_MS,
    fetch: async (start, end) => toPoolHashrateMinutes(
      await ctx.dataProxy.requestDataMap(RPC_METHODS.GET_WRK_EXT_DATA, {
        type: WORKER_TYPES.MINERPOOL,
        query: {
          key: MINERPOOL_EXT_DATA_KEYS.HASHRATE_1M,
          start,
          end,
          fields: { ts: 1, 'stats.poolType': 1, 'stats.hashrate': 1, 'stats.username': 1 }
        }
      })
    )
  }))
}

function getWindowStart (req, now) {
  return now - req.query.lookbackHours * REALTIME_CHARTS.HOUR_MS
}

async function getLiveConsumption (ctx, req) {
  if (!isCentralDCSEnabled(ctx)) {
    return { windowMs: REALTIME_CHARTS.WINDOW_MS, log: [] }
  }

  const now = Date.now()
  const since = Math.max(req.query.since ?? 0, getWindowStart(req, now))
  const log = await consumptionSeries(ctx).read(since, now)

  return { windowMs: REALTIME_CHARTS.WINDOW_MS, log }
}

async function getLivePoolHashrate (ctx, req) {
  const now = Date.now()
  const since = Math.max(req.query.since ?? 0, getWindowStart(req, now))
  const log = await poolHashrateSeries(ctx).read(since, now)

  return { intervalMs: REALTIME_CHARTS.HASHRATE_INTERVAL_MS, poolType: REALTIME_CHARTS.POOL_TYPE, log }
}

module.exports = {
  toConsumptionWindows,
  toPoolHashrateMinutes,
  getLiveConsumption,
  getLivePoolHashrate
}
