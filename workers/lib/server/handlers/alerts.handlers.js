'use strict'

const { randomUUID } = require('crypto')
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
  ALERT_EXT_DATA_WORKER_TYPES,
  GLOBAL_DATA_TYPES,
  CUSTOM_ALERT_CONFIG,
  AUTH_PERMISSIONS,
  AUTH_LEVELS,
  LOG_KEYS,
  WORKER_TYPES,
  WORKER_TAGS,
  SITE_STATUS_LIVE_AGGR_FIELDS,
  SITE_STATUS_LIVE_WINDOW_MS,
  DCS_POWER_METER_FIELDS
} = require('../../constants')
const { parseJsonQueryParam, validateFilter, applyMongoFilter, combineAnd, deduplicateAlerts } = require('../../utils')
const { aggregateMinerStats, calculateSiteEfficiency } = require('./site.utils')
const { getSiteConsumption } = require('./site.handlers')
const { isCentralDCSEnabled, fetchDcsThing, extractSiteMainMeterPowerW } = require('../../dcs.utils')

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

// Mirrors composeSiteStatus's efficiency calc (site.utils.js) using a fresh,
// lighter-weight fetch (miner hashrate + site power only, no pools/globalConfig).
async function computeSiteEfficiencyWPerTh (ctx) {
  const dcsEnabled = isCentralDCSEnabled(ctx)

  const [tailLogResults, powerSource] = await Promise.all([
    ctx.dataProxy.requestDataMap(RPC_METHODS.TAIL_LOG_MULTI, {
      keys: [{ key: LOG_KEYS.STAT_RTD, type: WORKER_TYPES.MINER, tag: WORKER_TAGS.MINER }],
      limit: 1,
      start: Date.now() - SITE_STATUS_LIVE_WINDOW_MS,
      aggrFields: SITE_STATUS_LIVE_AGGR_FIELDS
    }),
    dcsEnabled
      ? fetchDcsThing(ctx, { id: 1, code: 1, type: 1, tags: 1, ...DCS_POWER_METER_FIELDS })
      : getSiteConsumption(ctx)
  ])

  const { hashrate } = aggregateMinerStats(tailLogResults)
  const consumptionW = dcsEnabled ? extractSiteMainMeterPowerW(powerSource) : (powerSource?.powerW || 0)
  return calculateSiteEfficiency(hashrate, consumptionW)
}

// Site efficiency has no backing thing, so it's synthesized here rather than
// coming from `thing.last.alerts`. Each tier is gated independently by its own
// `enabled` flag and `maxSiteEfficiencyWThs` threshold; a missing threshold
// (not configured) means that tier never alerts.
const SITE_EFFICIENCY_ALERT_TIERS = [
  { key: 'custom.high_site_efficiency.critical', severity: 'critical' },
  { key: 'custom.high_site_efficiency.warning', severity: 'warning' }
]

function buildSiteEfficiencyAlert (key, severity, efficiencyWPerTh, threshold) {
  return {
    name: key,
    code: key,
    description: 'High Site Efficiency detected',
    severity,
    createdAt: Date.now(),
    id: null,
    uuid: randomUUID(),
    message: `Site efficiency ${efficiencyWPerTh.toFixed(2)} W/TH/s (max ${threshold} W/TH/s)`,
    deviceId: null,
    type: 'site'
  }
}

async function getSiteEfficiencyAlerts (ctx) {
  const [alertParams] = await ctx.globalDataLib.getGlobalData({ type: GLOBAL_DATA_TYPES.ALERT_PARAMETERS })

  const activeTiers = SITE_EFFICIENCY_ALERT_TIERS
    .map(({ key, severity }) => ({ key, severity, conf: alertParams?.[key] }))
    .filter(({ conf }) => conf?.enabled && typeof conf.maxSiteEfficiencyWThs === 'number')

  if (!activeTiers.length) return []

  const efficiencyWPerTh = await computeSiteEfficiencyWPerTh(ctx)

  const alerts = []
  for (const { key, severity, conf } of activeTiers) {
    const threshold = conf.maxSiteEfficiencyWThs
    if (efficiencyWPerTh > threshold) {
      alerts.push(buildSiteEfficiencyAlert(key, severity, efficiencyWPerTh, threshold))
    }
  }
  return alerts
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
  const [results, workerAlerts, siteEfficiencyAlerts] = await Promise.all([
    ctx.dataProxy.requestDataMap(RPC_METHODS.LIST_THINGS, {
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
    }),
    fetchWorkerExtAlerts(ctx, { key: 'alerts' }),
    getSiteEfficiencyAlerts(ctx)
  ])

  const things = results.flat()
  let alerts = extractAlertsFromThings(things)

  alerts = alerts.concat(workerAlerts)
  alerts = alerts.concat(siteEfficiencyAlerts)

  const summary = buildSiteAlertsSummary(alerts)

  alerts = applyMongoFilter(alerts, combineAnd(filter, typeFilter))
  alerts = alerts.filter(a => matchesSearch(a, search, SITE_ALERTS_SEARCH_FIELDS))
  alerts = applySort(alerts, sort)
  const total = alerts.length
  alerts = alerts.slice(offset, offset + limit)

  return { alerts, summary, total }
}

async function getAlertConf (ctx) {
  return CUSTOM_ALERT_CONFIG
}

async function getAlertParams (ctx) {
  return await ctx.globalDataLib.getGlobalData({
    type: GLOBAL_DATA_TYPES.ALERT_PARAMETERS
  })
}

// Users without the sensitive permission may only change `notes`; every other
// field is taken from the existing stored config, ignoring what was submitted.
function restrictToNotesOnly (submittedData, existingConfig) {
  const notesOnlyData = {}
  for (const alertKey in submittedData) {
    notesOnlyData[alertKey] = {
      ...(existingConfig?.[alertKey] ?? {}),
      notes: submittedData[alertKey]?.notes
    }
  }
  return notesOnlyData
}

async function setAlertParams (ctx, req) {
  const type = GLOBAL_DATA_TYPES.ALERT_PARAMETERS

  const sensitivePerm = `${AUTH_PERMISSIONS.ALERT_CONFIG_SENSITIVE}:${AUTH_LEVELS.WRITE}`
  const hasSensitivePerm = await ctx.authLib.tokenHasPerms(req._info.authToken, false, [sensitivePerm])

  let data = req.body.data
  if (!hasSensitivePerm) {
    const [existingConfig] = await ctx.globalDataLib.getGlobalData({ type })
    data = restrictToNotesOnly(data, existingConfig)
  }

  const byRackType = {}
  for (const alertKey in data) {
    const params = data[alertKey]

    const { rackTypes } = CUSTOM_ALERT_CONFIG[alertKey] ?? {}
    if (!rackTypes) {
      continue
    }

    for (const rackType of rackTypes) {
      if (!byRackType[rackType]) {
        byRackType[rackType] = {}
      }

      byRackType[rackType][alertKey] = params
    }
  }

  const res = await ctx.globalDataLib.setGlobalData(data, type)
  ctx.dataProxy.requestDataMap(RPC_METHODS.SET_ALERT_PARAMS, { byRackType }).catch((error) => {
    console.error('setAlertParams failed.', error)
  })
  return res
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
  getAlertConf,
  getAlertParams,
  setAlertParams,
  restrictToNotesOnly,
  extractAlertsFromThings,
  matchesSearch,
  applySort,
  buildSeveritySummary,
  buildSiteAlertsSummary,
  flattenHistoryAlert,
  computeSiteEfficiencyWPerTh,
  buildSiteEfficiencyAlert,
  getSiteEfficiencyAlerts
}
