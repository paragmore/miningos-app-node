'use strict'

const { parseJsonQueryParam, flattenRpcResults } = require('../../utils')
const {
  MINER_FIELD_MAP,
  MINER_PROJECTION_MAP,
  MINER_SEARCH_FIELDS,
  MINER_DEFAULT_FIELDS,
  MINER_MAX_LIMIT,
  MINER_DEFAULT_LIMIT,
  MINER_CATEGORIES,
  CONTAINER_MINER_FIELDS,
  WORKER_TAGS
} = require('../../constants')
const {
  mapFilterFields,
  mapSortFields,
  buildSearchQuery,
  flattenOrkResults,
  sortItems
} = require('../lib/queryUtils')

/**
 * Builds ork projection from user-requested clean field names.
 * Always includes id and code (needed for pool matching).
 * Includes sort field paths so app-side sorting works on projected data.
 */
function buildOrkProjection (userFields, mappedSort) {
  const projection = { id: 1, code: 1 }

  for (const [field, value] of Object.entries(userFields)) {
    if (value !== 1) continue
    const paths = MINER_PROJECTION_MAP[field]
    if (paths) {
      for (const path of paths) { projection[path] = 1 }
    } else {
      projection[field] = value
    }
  }

  if (mappedSort) {
    for (const path of Object.keys(mappedSort)) {
      projection[path] = 1
    }
  }

  return projection
}

function formatMiner (raw, poolWorkers, requestedFields) {
  const snap = raw.last?.snap || {}
  const stats = snap.stats || {}
  const config = snap.config || {}

  const include = (field) => !requestedFields || requestedFields.has(field)

  const miner = { id: raw.id }

  if (include('type')) miner.type = raw.type
  if (include('model')) miner.model = snap.model || raw.type
  if (include('code')) miner.code = raw.code
  if (include('ip')) miner.ip = raw.address || config.network_config?.ip_address
  if (include('subnet')) miner.subnet = raw.info?.subnet
  if (include('container')) miner.container = raw.info?.container
  if (include('rack')) miner.rack = raw.rack
  if (include('position')) miner.position = raw.info?.pos
  if (include('status')) miner.status = stats.status
  if (include('hashrate')) miner.hashrate = stats.hashrate_mhs || 0
  if (include('power')) miner.power = stats.power_w || 0
  if (include('temperature')) miner.temperature = stats.temperature_c
  if (include('frequency')) miner.frequency = stats.frequency_mhz
  if (include('efficiency')) miner.efficiency = stats.efficiency_w_ths || 0
  if (include('uptime')) miner.uptime = stats.uptime_ms
  if (include('firmware')) miner.firmware = config.firmware_ver
  if (include('powerMode')) miner.powerMode = config.power_mode
  if (include('ledStatus')) miner.ledStatus = config.led_status
  if (include('poolConfig')) miner.poolConfig = config.pool_config
  if (include('poolConfigId')) miner.poolConfigId = raw.info?.poolConfig
  if (include('alerts')) miner.alerts = raw.last?.alerts
  if (include('comments')) miner.comments = raw.comments
  if (include('serialNum')) miner.serialNum = raw.info?.serialNum
  if (include('macAddress')) miner.macAddress = raw.info?.macAddress
  if (include('lastSeen')) miner.lastSeen = raw.last?.ts || raw.ts

  if (poolWorkers && include('poolHashrate')) {
    const poolWorker = poolWorkers[raw.id] || poolWorkers[raw.code]
    if (poolWorker) {
      miner.poolHashrate = poolWorker.hashrate || 0
    }
  }

  return miner
}

function extractPoolWorkers (poolDataResults) {
  const workers = {}
  for (const orkResult of poolDataResults) {
    if (!Array.isArray(orkResult)) continue
    for (const pool of orkResult) {
      if (!pool || !pool.workers) continue
      for (const [workerId, workerData] of Object.entries(pool.workers)) {
        workers[workerId] = workerData
      }
    }
  }
  return workers
}

async function listMiners (ctx, req) {
  const userFilter = req.query.filter
    ? parseJsonQueryParam(req.query.filter, 'ERR_FILTER_INVALID_JSON')
    : {}

  const mappedFilter = mapFilterFields(userFilter, MINER_FIELD_MAP)

  const query = {
    $and: [
      { tags: { $in: ['t-miner'] } },
      ...(Object.keys(mappedFilter).length ? [mappedFilter] : []),
      ...(req.query.search ? [buildSearchQuery(req.query.search, MINER_SEARCH_FIELDS)] : [])
    ]
  }

  const mappedSort = req.query.sort
    ? mapSortFields(parseJsonQueryParam(req.query.sort, 'ERR_SORT_INVALID_JSON'), MINER_FIELD_MAP)
    : undefined

  const userFields = req.query.fields
    ? parseJsonQueryParam(req.query.fields, 'ERR_FIELDS_INVALID_JSON')
    : null

  const orkProjection = userFields
    ? buildOrkProjection(userFields, mappedSort)
    : MINER_DEFAULT_FIELDS

  const requestedFields = userFields
    ? new Set(Object.keys(userFields).filter(k => userFields[k] === 1))
    : null

  const offset = req.query.offset || 0
  const limit = Math.min(req.query.limit || MINER_DEFAULT_LIMIT, MINER_MAX_LIMIT)
  const fetchLimit = offset + limit

  const dataPayload = { query, fields: orkProjection, status: 1 }
  if (mappedSort) { dataPayload.sort = mappedSort }

  const [orkResults, countResults] = await Promise.all([
    ctx.dataProxy.requestDataMap('listThings', { ...dataPayload, limit: fetchLimit }),
    ctx.dataProxy.requestDataMap('getThingsCount', { query, status: 1 })
  ])

  let items = flattenOrkResults(orkResults)
  const totalCount = countResults.reduce((acc, c) => acc + (c || 0), 0)

  if (mappedSort) {
    items = sortItems(items, mappedSort)
  }

  let poolWorkers = null
  if (ctx.conf.featureConfig?.poolStats) {
    try {
      const poolData = await ctx.dataProxy.requestDataMap('getWrkExtData', {
        type: 'minerpool',
        query: { key: 'stats' }
      })
      poolWorkers = extractPoolWorkers(poolData)
    } catch { }
  }

  const page = items.slice(offset, offset + limit)

  return {
    data: page.map(miner => formatMiner(miner, poolWorkers, requestedFields)),
    totalCount,
    offset,
    limit,
    hasMore: offset + limit < totalCount
  }
}

function sanitizeIncludeFields (fields) {
  if (!fields || typeof fields !== 'object') return null
  const clean = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value === 1) clean[key] = 1
  }
  return Object.keys(clean).length ? clean : null
}

function summarizeMinerActivity (miners) {
  const summary = { total: miners.length, offline: 0, powerModes: {} }
  for (const miner of miners) {
    const snap = miner.last?.snap || {}
    if (snap.stats?.status === MINER_CATEGORIES.OFFLINE) {
      summary.offline++
      continue
    }
    const mode = snap.config?.power_mode || 'unknown'
    summary.powerModes[mode] = (summary.powerModes[mode] || 0) + 1
  }
  return summary
}

async function listContainerMiners (ctx, req) {
  const requested = req.query.fields
    ? sanitizeIncludeFields(parseJsonQueryParam(req.query.fields, 'ERR_FIELDS_INVALID_JSON'))
    : null
  const fields = requested ? { id: 1, type: 1, ...requested } : CONTAINER_MINER_FIELDS

  const results = await ctx.dataProxy.requestDataAllPages('listThings', {
    query: {
      $and: [
        { tags: { $in: [`container-${req.params.id}`] } },
        { tags: { $in: [WORKER_TAGS.MINER] } }
      ]
    },
    fields,
    status: 1
  })

  const miners = sortItems(flattenRpcResults(results), { id: 1 })

  return {
    miners,
    total: miners.length,
    summary: summarizeMinerActivity(miners)
  }
}

async function listFirmwares (ctx, req) {
  return await ctx.dataProxy.requestDataMap('listFirmwares', {})
}

module.exports = {
  listMiners,
  listContainerMiners,
  summarizeMinerActivity,
  sanitizeIncludeFields,
  formatMiner,
  extractPoolWorkers,
  buildOrkProjection,
  listFirmwares
}
