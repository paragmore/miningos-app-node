'use strict'

const {
  RPC_METHODS,
  SEVERITY_LEVELS,
  SEVERITY_RANK,
  ALERTS_DEFAULT_LIMIT,
  ALERTS_MAX_SITE_LIMIT,
  ALERTS_MAX_HISTORY_LIMIT,
  SITE_ALERTS_FILTER_FIELDS,
  SITE_ALERTS_SEARCH_FIELDS,
  HISTORY_FILTER_FIELDS,
  HISTORY_SEARCH_FIELDS,
  ALERTS_FILTER_OPERATORS,
  MINER_TYPE_REGEX,
  HISTORY_ALERTS_QUERY_MAP,
  ALERT_EXT_DATA_WORKER_TYPES
} = require('../../constants')
const { parseJsonQueryParam, validateFilter, applyMongoFilter, combineAnd, deduplicateAlerts } = require('../../utils')

function extractAlertsFromThings (things) {
  const alerts = []
  for (const thing of things) {
    if (Array.isArray(thing?.last?.alerts)) {
      for (const alert of thing.last.alerts) {
        if (alert && typeof alert === 'object' && !Array.isArray(alert)) {
          alerts.push({
            ...alert,
            id: thing.id,
            deviceId: thing.id,
            type: thing.type,
            code: thing.code,
            container: thing.info?.container,
            position: thing.info?.pos
          })
        }
      }
    }
  }
  return alerts
}

// Worker alerts use the same flat shape as thing alerts, so they merge as-is.
async function fetchWorkerExtAlerts (ctx, query) {
  const alerts = []
  for (const type of ALERT_EXT_DATA_WORKER_TYPES) {
    let results
    try {
      results = await ctx.dataProxy.requestDataMap(RPC_METHODS.GET_WRK_EXT_DATA, { type, query })
    } catch {
      continue
    }
    for (const entry of results.flat()) {
      if (Array.isArray(entry?.alerts)) alerts.push(...entry.alerts)
    }
  }
  return alerts
}

function matchesSearch (item, search, fields) {
  if (!search) return true
  const lowerSearch = search.toLowerCase()
  for (const field of fields) {
    const val = item[field]
    if (val != null && String(val).toLowerCase().includes(lowerSearch)) {
      return true
    }
  }
  return false
}

// Severity compares by rank (critical > high > medium > low), not alphabetically.
function sortValue (item, field) {
  const val = item[field]
  return field === 'severity' ? SEVERITY_RANK[val] ?? 0 : val
}

function applySort (items, sort) {
  if (!sort) return items
  const entries = Object.entries(sort)
  if (!entries.length) return items

  return items.slice().sort((a, b) => {
    for (const [field, dir] of entries) {
      const aVal = sortValue(a, field)
      const bVal = sortValue(b, field)
      if (aVal < bVal) return dir === 1 ? -1 : 1
      if (aVal > bVal) return dir === 1 ? 1 : -1
    }
    return 0
  })
}

function buildSeveritySummary (alerts) {
  const summary = { critical: 0, high: 0, medium: 0, low: 0, total: alerts.length }
  for (const alert of alerts) {
    if (SEVERITY_LEVELS.has(alert.severity)) {
      summary[alert.severity]++
    }
  }
  return summary
}

const MINER_TYPE_RE = new RegExp(MINER_TYPE_REGEX)

// Splits by thing type: miner family (incl. subtypes) vs everything else.
function buildSiteAlertsSummary (alerts) {
  const miner = []
  const operational = []
  for (const alert of alerts) {
    (MINER_TYPE_RE.test(alert.type || '') ? miner : operational).push(alert)
  }
  return {
    operational: buildSeveritySummary(operational),
    miner: buildSeveritySummary(miner)
  }
}

function flattenHistoryAlert (entry) {
  const thing = entry.thing || {}
  return {
    name: entry.name,
    description: entry.description,
    severity: entry.severity,
    createdAt: entry.createdAt,
    uuid: entry.uuid,
    message: entry.message,
    deviceId: thing.id,
    type: thing.type,
    code: thing.code,
    container: thing.info?.container,
    position: thing.info?.pos,
    tags: thing.tags
  }
}

// Maps filter fields to the worker's nested `thing.*` paths for getHistoricalLogs.
function buildHistoryAlertsQuery (filter) {
  const query = {}
  for (const [field, cond] of Object.entries(filter)) {
    query[HISTORY_ALERTS_QUERY_MAP[field]] = cond
  }
  return Object.keys(query).length ? query : undefined
}

// `type` param -> type-field condition; undefined means no extra constraint.
function alertTypeCondition (type) {
  if (type === 'miner') return { $regex: MINER_TYPE_REGEX }
  if (type === 'operational') return { $not: { $regex: MINER_TYPE_REGEX } }
  return undefined
}

async function getSiteAlerts (ctx, req) {
  const filter = validateFilter(
    parseJsonQueryParam(req.query.filter, 'ERR_INVALID_FILTER'),
    SITE_ALERTS_FILTER_FIELDS,
    ALERTS_FILTER_OPERATORS
  )
  const sort = parseJsonQueryParam(req.query.sort, 'ERR_INVALID_SORT')
  const search = req.query.search || ''
  const offset = Number(req.query.offset) || 0
  const limit = Math.min(Number(req.query.limit) || ALERTS_DEFAULT_LIMIT, ALERTS_MAX_SITE_LIMIT)

  const typeCond = alertTypeCondition(req.query.type)
  const typeFilter = typeCond ? { type: typeCond } : null

  // The summary needs the full alert set, so fetch every alerted thing and
  // apply filter/type/search in memory on the merged result.
  const results = await ctx.dataProxy.requestDataMap(RPC_METHODS.LIST_THINGS, {
    status: 1,
    query: { 'last.alerts': { $ne: null } },
    fields: {
      'last.alerts': 1,
      'info.container': 1,
      'info.pos': 1,
      type: 1,
      id: 1,
      code: 1
    }
  })

  const things = results.flat()
  let alerts = extractAlertsFromThings(things)

  alerts = alerts.concat(await fetchWorkerExtAlerts(ctx, { key: 'alerts' }))

  const summary = buildSiteAlertsSummary(alerts)

  alerts = applyMongoFilter(alerts, combineAnd(filter, typeFilter))
  alerts = alerts.filter(a => matchesSearch(a, search, SITE_ALERTS_SEARCH_FIELDS))
  alerts = applySort(alerts, sort)
  const total = alerts.length
  alerts = alerts.slice(offset, offset + limit)

  return { alerts, summary, total }
}

async function getAlertsHistory (ctx, req) {
  const start = Number(req.query.start)
  const end = Number(req.query.end)

  if (start >= end) {
    throw new Error('ERR_INVALID_DATE_RANGE')
  }

  const filter = validateFilter(
    parseJsonQueryParam(req.query.filter, 'ERR_INVALID_FILTER'),
    HISTORY_FILTER_FIELDS,
    ALERTS_FILTER_OPERATORS
  )
  const sort = parseJsonQueryParam(req.query.sort, 'ERR_INVALID_SORT') || { createdAt: -1 }
  const search = req.query.search || ''
  const offset = Number(req.query.offset) || 0
  const limit = Math.min(Number(req.query.limit) || ALERTS_DEFAULT_LIMIT, ALERTS_MAX_HISTORY_LIMIT)

  // Worker filters on nested `thing.type`; handler re-filters on flattened `deviceType`.
  const typeCond = alertTypeCondition(req.query.type)
  const workerQuery = combineAnd(buildHistoryAlertsQuery(filter) || {}, typeCond ? { 'thing.type': typeCond } : null)

  const results = await ctx.dataProxy.requestDataMap(RPC_METHODS.GET_HISTORICAL_LOGS, {
    start,
    end,
    logType: 'alerts',
    query: Object.keys(workerQuery).length ? workerQuery : undefined
  })

  let alerts = results.flat().map(flattenHistoryAlert)

  // Worker history entries are already flat, so concat directly (no flatten).
  alerts = alerts.concat(await fetchWorkerExtAlerts(ctx, { key: 'alerts-history', start, end }))
  alerts = deduplicateAlerts(alerts)

  // Re-apply on the merged result for global correctness.
  alerts = applyMongoFilter(alerts, combineAnd(filter, typeCond ? { type: typeCond } : null))
  alerts = alerts.filter(a => matchesSearch(a, search, HISTORY_SEARCH_FIELDS))

  alerts = applySort(alerts, sort)
  const total = alerts.length
  alerts = alerts.slice(offset, offset + limit)

  return { alerts, total }
}

module.exports = {
  getSiteAlerts,
  getAlertsHistory,
  extractAlertsFromThings,
  matchesSearch,
  applySort,
  buildSeveritySummary,
  buildSiteAlertsSummary,
  flattenHistoryAlert
}
