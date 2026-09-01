'use strict'

const mingo = require('mingo')
const {
  RPC_METHODS,
  WORKER_TYPES,
  MINERPOOL_EXT_DATA_KEYS,
  RANGE_BUCKETS,
  MINER_FIELD_MAP
} = require('../../constants')
const {
  parseJsonQueryParam,
  getStartOfDay
} = require('../../utils')

async function getPools (ctx, req) {
  const filter = req.query.query ? parseJsonQueryParam(req.query.query, 'ERR_QUERY_INVALID_JSON') : null
  const sort = req.query.sort ? parseJsonQueryParam(req.query.sort, 'ERR_SORT_INVALID_JSON') : null
  const fields = req.query.fields ? parseJsonQueryParam(req.query.fields, 'ERR_FIELDS_INVALID_JSON') : null

  const statsResults = await ctx.dataProxy.requestDataMap(RPC_METHODS.GET_WRK_EXT_DATA, {
    type: 'minerpool',
    query: { key: MINERPOOL_EXT_DATA_KEYS.STATS }
  })

  const pools = flattenPoolStats(statsResults)

  const query = new mingo.Query(filter || {})
  let cursor = query.find(pools, fields || {})
  if (sort) cursor = cursor.sort(sort)
  const result = cursor.all()

  const summary = calculatePoolsSummary(pools)

  return { pools: result, summary }
}

function flattenPoolStats (results) {
  const pools = []
  const seen = new Set()
  if (!Array.isArray(results)) return pools

  for (const orkResult of results) {
    if (!orkResult || orkResult.error) continue
    const items = Array.isArray(orkResult) ? orkResult : (orkResult.data || orkResult.result || [])
    if (!Array.isArray(items)) continue

    for (const item of items) {
      if (!item) continue
      const stats = item.stats || item.data || []
      if (!Array.isArray(stats)) continue

      for (const stat of stats) {
        if (!stat) continue
        const poolKey = `${stat.poolType}:${stat.username}`
        if (seen.has(poolKey)) continue
        seen.add(poolKey)

        pools.push({
          name: stat.username || stat.poolType,
          pool: stat.poolType,
          account: stat.username,
          status: 'active',
          hashrate: stat.hashrate || 0,
          hashrate1h: stat.hashrate_1h || 0,
          hashrate24h: stat.hashrate_24h || 0,
          workerCount: stat.worker_count || 0,
          activeWorkerCount: stat.active_workers_count || 0,
          balance: stat.balance || 0,
          unsettled: stat.unsettled || 0,
          revenue24h: stat.revenue_24h || stat.estimated_today_income || 0,
          yearlyBalances: stat.yearlyBalances || [],
          lastUpdated: stat.timestamp || null
        })
      }
    }
  }

  return pools
}

function calculatePoolsSummary (pools) {
  const totals = pools.reduce((acc, pool) => {
    acc.totalHashrate += pool.hashrate || 0
    acc.totalWorkers += pool.workerCount || pool.worker_count || 0
    acc.totalBalance += pool.balance || 0
    return acc
  }, { totalHashrate: 0, totalWorkers: 0, totalBalance: 0 })

  return {
    poolCount: pools.length,
    ...totals
  }
}

async function getPoolBalanceHistory (ctx, req) {
  const start = Number(req.query.start)
  const end = Number(req.query.end)
  const range = req.query.range || '1D'
  const poolParam = req.params.pool || null
  const poolFilter = poolParam === 'all' ? null : poolParam

  if (!start || !end) {
    throw new Error('ERR_MISSING_START_END')
  }

  if (start >= end) {
    throw new Error('ERR_INVALID_DATE_RANGE')
  }

  const results = await ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
    type: 'minerpool',
    query: { key: MINERPOOL_EXT_DATA_KEYS.TRANSACTIONS, start, end, pool: poolFilter }
  })

  const dailyEntries = flattenTransactionResults(results)

  const bucketSize = RANGE_BUCKETS[range] || RANGE_BUCKETS['1D']
  const buckets = groupByBucket(dailyEntries, bucketSize)

  const log = Object.entries(buckets)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([ts, entries]) => {
      const totalRevenue = entries.reduce((sum, e) => sum + (e.revenue || 0), 0)
      const hashrates = entries.filter(e => e.hashrate > 0)
      const avgHashrate = hashrates.length
        ? hashrates.reduce((sum, e) => sum + e.hashrate, 0) / hashrates.length
        : 0

      return {
        ts: Number(ts),
        balance: totalRevenue,
        hashrate: avgHashrate,
        revenue: totalRevenue
      }
    })

  return { log }
}

function flattenTransactionResults (results) {
  const daily = []
  for (const res of results) {
    if (res.error || !res) continue
    const data = Array.isArray(res) ? res : (res.data || res.result || [])
    if (!Array.isArray(data)) continue

    for (const entry of data) {
      if (!entry) continue
      const ts = Number(entry.ts)
      if (!ts) continue

      const txs = entry.transactions || []
      if (!Array.isArray(txs) || txs.length === 0) continue

      let revenue = 0
      let hashrate = 0
      let hashCount = 0

      for (const tx of txs) {
        if (!tx) continue
        revenue += Math.abs(tx.changed_balance || 0)
        if (tx.mining_extra?.hash_rate) {
          hashrate += tx.mining_extra.hash_rate
          hashCount++
        }
      }

      if (revenue === 0 && hashCount === 0) continue

      daily.push({
        ts: getStartOfDay(ts),
        revenue,
        hashrate: hashCount > 0 ? hashrate / hashCount : 0
      })
    }
  }

  return daily
}

function groupByBucket (entries, bucketSize) {
  const buckets = {}
  for (const entry of entries) {
    const ts = entry.ts
    if (!ts) continue
    const bucketTs = Math.floor(ts / bucketSize) * bucketSize
    if (!buckets[bucketTs]) buckets[bucketTs] = []
    buckets[bucketTs].push(entry)
  }
  return buckets
}

function flattenPoolStatsHistory (results) {
  const entries = []
  if (!Array.isArray(results)) return entries

  for (const res of results) {
    if (!res || res.error) continue
    const data = Array.isArray(res) ? res : (res.data || res.result || [])
    if (!Array.isArray(data)) continue

    for (const entry of data) {
      if (!entry) continue
      const ts = Number(entry.ts)
      if (!ts || !Array.isArray(entry.stats)) continue
      entries.push({ ts, stats: entry.stats })
    }
  }

  return entries
}

/**
 * Site-wide pool-reported hashrate per report bucket, from the minerpool
 * workers' raw stats snapshots (H/s). Each account's samples are averaged
 * within the bucket before summing across accounts, so accounts polling at
 * different rates (or served by different racks) don't skew the site total.
 *
 * `buckets` are `{ ts, startTs, endTs }` windows; returns a Map keyed by
 * bucket `ts` with the pool hashrate in MH/s, or null for windows without
 * samples.
 */
async function resolvePoolHashrateForBuckets (ctx, { start, end, buckets }) {
  const byBucket = new Map()
  if (!Array.isArray(buckets) || !buckets.length) return byBucket

  const results = await ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
    type: WORKER_TYPES.MINERPOOL,
    query: {
      key: MINERPOOL_EXT_DATA_KEYS.STATS_HISTORY,
      start,
      end,
      // Projected on the rack before the data travels: a month of raw 5m
      // snapshots is ~10MB with full stat docs but ~2MB with only the fields
      // this calculation reads.
      fields: { ts: 1, 'stats.poolType': 1, 'stats.username': 1, 'stats.hashrate': 1 }
    }
  })

  const sorted = buckets.slice().sort((a, b) => a.startTs - b.startTs)
  const accountsPerBucket = sorted.map(() => new Map())

  const findBucketIdx = (ts) => {
    let lo = 0
    let hi = sorted.length - 1
    let idx = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (sorted[mid].startTs <= ts) {
        idx = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return idx >= 0 && ts <= sorted[idx].endTs ? idx : -1
  }

  for (const { ts, stats } of flattenPoolStatsHistory(results)) {
    const idx = findBucketIdx(ts)
    if (idx === -1) continue

    for (const stat of stats) {
      const hashrate = Number(stat?.hashrate)
      if (!Number.isFinite(hashrate)) continue
      const account = `${stat.poolType}:${stat.username}`
      const acc = accountsPerBucket[idx].get(account) || { total: 0, count: 0 }
      acc.total += hashrate
      acc.count++
      accountsPerBucket[idx].set(account, acc)
    }
  }

  sorted.forEach((bucket, idx) => {
    const accounts = accountsPerBucket[idx]
    if (!accounts.size) {
      byBucket.set(bucket.ts, null)
      return
    }
    let totalHs = 0
    for (const { total, count } of accounts.values()) totalHs += total / count
    byBucket.set(bucket.ts, totalHs / 1e6)
  })

  return byBucket
}

const getPoolThingConfig = async (ctx, req) => {
  const thing = await ctx.dataProxy.requestData(RPC_METHODS.LIST_THINGS, {
    query: { id: req.params.id }, fields: { info: 1 }
  })
  const rack = thing?.[0]?.[0]?.rack
  const info = thing?.[0]?.[0]?.info
  if (!rack || !info) throw new Error('ERR_THING_NOT_FOUND')
  if (rack?.startsWith(WORKER_TYPES.MINER)) {
    return { poolConfig: info?.poolConfig || null, overriddenConfig: 0 }
  }

  const miners = await ctx.dataProxy.requestData(RPC_METHODS.LIST_THINGS, {
    query: { tags: { $in: [`container-${info.container}`] } },
    fields: { 'info.poolConfig': 1 }
  })
  const overriddenConfig = miners?.[0]?.filter(m => m.info?.poolConfig && m.info?.poolConfig !== info?.poolConfig)?.length || 0
  return { poolConfig: info?.poolConfig || null, overriddenConfig }
}

const getPoolStatsContainers = async (ctx, req) => {
  const fields = { [MINER_FIELD_MAP.container]: 1, [MINER_FIELD_MAP.poolConfig]: 1 }
  const containers = await ctx.dataProxy.requestData(RPC_METHODS.LIST_THINGS, {
    fields, query: { tags: { $in: ['t-container'] } }
  })
  const containerIds = containers?.[0]?.filter(m => m.info?.poolConfig).map(m => m.info.container)
  const miners = await ctx.dataProxy.requestData(RPC_METHODS.LIST_THINGS, {
    fields, query: { [MINER_FIELD_MAP.container]: { $in: containerIds } }
  })

  return containers?.[0]?.map(data => {
    if (!data.info?.poolConfig) return { container: data.info.container, overriddenConfig: 0 }
    return {
      container: data.info.container,
      overriddenConfig: miners?.[0]?.filter(m => m.info?.poolConfig && m.info?.container === data.info?.container && m.info?.poolConfig !== data.info?.poolConfig)?.length || 0
    }
  })
}

module.exports = {
  getPools,
  flattenPoolStats,
  calculatePoolsSummary,
  getPoolBalanceHistory,
  flattenTransactionResults,
  flattenPoolStatsHistory,
  resolvePoolHashrateForBuckets,
  groupByBucket,
  getPoolThingConfig,
  getPoolStatsContainers
}
