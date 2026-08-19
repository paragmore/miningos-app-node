'use strict'

const {
  WORKER_TYPES,
  AGGR_FIELDS,
  RPC_METHODS,
  METRICS_TIME,
  METRICS_DEFAULTS,
  RANGE_BUCKETS,
  MINER_CATEGORIES,
  LOG_KEYS,
  WORKER_TAGS,
  DEVICE_LIST_FIELDS,
  LOG_FIELDS,
  COOLING_METRICS_AGGR_FIELDS,
  SPARE_PART_TYPES,
  sparePartTag,
  SITE_STATUS_LIVE_WINDOW_MS
} = require('../../constants')
const {
  getStartOfDay,
  safeDiv,
  flattenRpcResults
} = require('../../utils')
const {
  isCentralDCSEnabled,
  getDCSTag
} = require('../../dcs.utils')
const {
  parseEntryTs,
  parseEntryTimeRange,
  validateStartEnd,
  iterateRpcEntries,
  sumObjectValues,
  extractContainerFromMinerKey,
  resolveInterval,
  getIntervalConfig,
  mergeGroupedField,
  extractKeyEntry,
  mhsToThs,
  rackFilterFor
} = require('../../metrics.utils')
const { parseRacks } = require('../lib/queryUtils')

function firstOrkEntries (res) {
  return Array.isArray(res?.[0]) ? res[0] : []
}

// `racks` without an explicit groupBy scopes the site-wide series to the selected racks,
// collapsing the rack-grouped series back to a scalar so the response shape is unchanged.
function rackGroupedReq (req) {
  return { query: { ...req.query, groupBy: 'rack' } }
}

function hasRackFilter (req) {
  return !req.query.groupBy && !!parseRacks(req)?.length
}

function avgObjectValues (obj) {
  const values = Object.values(obj || {}).map(Number).filter(Boolean)
  return safeDiv(values.reduce((sum, val) => sum + val, 0), values.length)
}

function readHashrate (val, container) {
  if (container) return Number(val?.[container]) || 0
  return Number(val) || 0
}

// Latest stat-rtd sample, for charts that pair a series with a live value.
async function getCurrentHashrate (ctx, aggrField, container) {
  const res = await ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, {
    type: WORKER_TYPES.MINER,
    tag: WORKER_TAGS.MINER,
    key: LOG_KEYS.STAT_RTD,
    limit: 1,
    start: Date.now() - SITE_STATUS_LIVE_WINDOW_MS,
    aggrFields: { [aggrField]: 1 }
  })

  const entry = firstOrkEntries(res)[0]

  return entry ? readHashrate(entry[aggrField], container) : null
}

async function getHashrate (ctx, req) {
  const { start, end } = validateStartEnd(req)

  if (req.query.groupBy) return getGoupedHashrate(ctx, req)

  if (hasRackFilter(req)) {
    const { log } = await getGoupedHashrate(ctx, rackGroupedReq(req))
    const scoped = log.map(({ ts, hashrateMhs }) => ({ ts, hashrateMhs: sumObjectValues(hashrateMhs) }))
    return { log: scoped, summary: calculateHashrateSummary(scoped) }
  }

  const { key, groupRange } = getIntervalConfig(resolveInterval(start, end, req.query.interval))
  const container = req.query.container || null
  const field = container ? LOG_FIELDS.HASHRATE_SUM_CONTAINER_GROUP : LOG_FIELDS.HASHRATE_SUM
  const aggrField = container ? AGGR_FIELDS.HASHRATE_SUM_CONTAINER_GROUP_AGGR : AGGR_FIELDS.HASHRATE_SUM
  // Invoicing needs delivered hashrate against the capacity installed at the time of each
  // bucket, which only the per-bucket aggregate carries. Opt-in: the site nominal alone is
  // served by /auth/site/status/live.
  const withNominal = req.query.nominal === true || req.query.nominal === 'true'

  const res = await ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, {
    type: WORKER_TYPES.MINER,
    tag: WORKER_TAGS.MINER,
    key,
    groupRange,
    shouldCalculateAvg: true,
    start,
    end,
    fields: { [field]: 1, ...(withNominal && { [LOG_FIELDS.NOMINAL_HASHRATE_SUM]: 1 }) },
    aggrFields: { [aggrField]: 1, ...(withNominal && { [AGGR_FIELDS.NOMINAL_HASHRATE_SUM]: 1 }) }
  })

  const log = firstOrkEntries(res).map(val => {
    const timeRange = parseEntryTimeRange(val.ts)
    const hashrateMhs = readHashrate(val[aggrField], container)
    if (!withNominal) {
      return {
        ts: parseEntryTs(val.ts),
        ...(timeRange && { timeRange }),
        hashrateMhs
      }
    }

    const nominalHashrateMhs = Number(val[AGGR_FIELDS.NOMINAL_HASHRATE_SUM]) || 0
    return {
      ts: parseEntryTs(val.ts),
      ...(timeRange && { timeRange }),
      hashrateMhs,
      nominalHashrateMhs,
      pctOfNominal: nominalHashrateMhs ? (hashrateMhs / nominalHashrateMhs) * 100 : null
    }
  })

  const summary = calculateHashrateSummary(log, withNominal)

  if (req.query.current) {
    summary.currentHashrateMhs = await getCurrentHashrate(ctx, aggrField, container)
  }

  return { log, summary }
}

const HASHRATE_GROUP_FIELDS = {
  miner: { field: LOG_FIELDS.HASHRATE_SUM_TYPE_GROUP, aggrField: AGGR_FIELDS.HASHRATE_SUM_TYPE_GROUP_AGGR },
  container: { field: LOG_FIELDS.HASHRATE_SUM_CONTAINER_GROUP, aggrField: AGGR_FIELDS.HASHRATE_SUM_CONTAINER_GROUP_AGGR },
  rack: { field: LOG_FIELDS.HASHRATE_SUM_RACK_GROUP, aggrField: AGGR_FIELDS.HASHRATE_SUM_RACK_GROUP_AGGR }
}

async function getGoupedHashrate (ctx, req) {
  const { groupBy, start, end } = req.query

  const { field, aggrField } = HASHRATE_GROUP_FIELDS[groupBy]

  const res = await ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, {
    type: WORKER_TYPES.MINER,
    tag: WORKER_TAGS.MINER,
    key: LOG_KEYS.STAT_1D,
    start,
    end,
    fields: { [field]: 1 },
    aggrFields: { [aggrField]: 1 }
  })

  const rackFilter = groupBy === 'rack' ? rackFilterFor(parseRacks(req)) : null

  const log = res[0].reduce((aggr, val) => {
    let hashrateMhs = val[aggrField]
    if (rackFilter && hashrateMhs && typeof hashrateMhs === 'object') {
      hashrateMhs = Object.fromEntries(Object.entries(hashrateMhs).filter(([rack]) => rackFilter(rack)))
    }
    aggr.push({ ts: parseEntryTs(val.ts), hashrateMhs })
    return aggr
  }, [])

  const summary = calculateGroupedHashrateSummary(log, groupBy)

  return { log, summary }
}

function calculateHashrateSummary (log, withNominal = false) {
  if (!log.length) {
    return withNominal
      ? { avgHashrateMhs: null, nominalHashrateMhs: null, avgPctOfNominal: null }
      : { avgHashrateMhs: null }
  }

  const total = log.reduce((sum, entry) => sum + (entry.hashrateMhs || 0), 0)
  const summary = { avgHashrateMhs: safeDiv(total, log.length) }

  if (!withNominal) return summary

  const nominalTotal = log.reduce((sum, entry) => sum + (entry.nominalHashrateMhs || 0), 0)
  const avgNominal = safeDiv(nominalTotal, log.length)

  summary.nominalHashrateMhs = avgNominal
  summary.avgPctOfNominal = avgNominal ? (summary.avgHashrateMhs / avgNominal) * 100 : null

  return summary
}

function calculateGroupedHashrateSummary (log, groupBy) {
  if (!log.length) return { avgHashrateMhs: null }

  const groupTotals = {}
  const groupCounts = {}

  for (const entry of log) {
    const hashrate = entry.hashrateMhs
    if (typeof hashrate === 'object' && hashrate !== null) {
      for (const [name, val] of Object.entries(hashrate)) {
        const v = Number(val) || 0
        groupTotals[name] = (groupTotals[name] || 0) + v
        groupCounts[name] = (groupCounts[name] || 0) + 1
      }
    }
  }

  const byGroup = {}
  let siteTotal = 0
  for (const [name, total] of Object.entries(groupTotals)) {
    byGroup[name] = { avgHashrateMhs: safeDiv(total, groupCounts[name]) }
    siteTotal += total
  }

  return {
    avgHashrateMhs: safeDiv(siteTotal, log.length),
    groupedBy: byGroup
  }
}

// getIntervalConfig always buckets samples into a fixed window, so translate
// that window into the number of hours a single entry represents.
function bucketHours (groupRange) {
  const bucketMs = RANGE_BUCKETS[groupRange]

  return bucketMs ? bucketMs / (60 * 60 * 1_000) : 1 // '1H'
}

async function getConsumption (ctx, req) {
  const { start, end } = validateStartEnd(req)

  if (req.query.groupBy) return getGroupedConsumption(ctx, req)

  if (hasRackFilter(req)) {
    const { log } = await getGroupedConsumption(ctx, rackGroupedReq(req))
    const scoped = log.map(({ ts, powerW }) => {
      const scopedPowerW = sumObjectValues(powerW)
      return { ts, powerW: scopedPowerW, consumptionMWh: (scopedPowerW * 24) / 1000000 }
    })
    return { log: scoped, summary: calculateConsumptionSummary(scoped) }
  }

  // by_meter_power_w is a per-meter breakdown only produced by the DCS worker,
  // so it gets its own DCS-only flow.
  const byMeter = req.query.byMeter === true || req.query.byMeter === 'true'
  if (byMeter) return getByMeterConsumption(ctx, req)

  const { key, groupRange } = getIntervalConfig(resolveInterval(start, end, req.query.interval))

  // Central-DCS sites report site power through the Siemens DCS worker's stat log
  // (site_power_w), not a powermeter worker
  const dcsEnabled = isCentralDCSEnabled(ctx)

  const requestParams = dcsEnabled
    ? {
        type: WORKER_TYPES.DCS,
        tag: getDCSTag(ctx)
      }
    : {
        type: WORKER_TYPES.POWERMETER,
        tag: WORKER_TAGS.POWERMETER
      }

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

  const hours = bucketHours(groupRange)
  const log = firstOrkEntries(res).map(val => {
    const powerW = Number(val[AGGR_FIELDS.SITE_POWER]) || 0
    const timeRange = parseEntryTimeRange(val.ts)
    return {
      ts: parseEntryTs(val.ts),
      ...(timeRange && { timeRange }),
      powerW,
      consumptionMWh: (powerW * hours) / 1000000
    }
  })

  const summary = calculateConsumptionSummary(log)

  return { log, summary }
}

// by_meter_power_w is only produced by the DCS worker, so the per-meter breakdown
// is only meaningful when Central-DCS is enabled.
async function getByMeterConsumption (ctx, req) {
  const { start, end } = validateStartEnd(req)

  if (!isCentralDCSEnabled(ctx)) {
    throw new Error('ERR_BY_METER_REQUIRES_CENTRAL_DCS')
  }

  const { key, groupRange } = getIntervalConfig(resolveInterval(start, end, req.query.interval))

  const res = await ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, {
    type: WORKER_TYPES.DCS,
    tag: getDCSTag(ctx),
    key,
    groupRange,
    shouldCalculateAvg: true,
    start,
    end,
    fields: { [LOG_FIELDS.BY_METER_POWER]: 1 },
    aggrFields: { [AGGR_FIELDS.BY_METER_POWER]: 1 }
  })

  const hours = bucketHours(groupRange)

  return buildByMeterConsumption(firstOrkEntries(res), AGGR_FIELDS.BY_METER_POWER, hours)
}

// by_meter_power_w arrives as a { meter: powerW } map per bucket. Mirror the
// grouped-consumption shape so each entry carries per-meter power/consumption.
function buildByMeterConsumption (entries, aggrField, hours) {
  const log = entries.map(val => {
    const raw = val[aggrField]
    const powerW = raw && typeof raw === 'object' ? raw : {}
    const timeRange = parseEntryTimeRange(val.ts)
    return {
      ts: parseEntryTs(val.ts),
      ...(timeRange && { timeRange }),
      powerW,
      consumptionMWh: Object.fromEntries(
        Object.entries(powerW).map(([meter, w]) => [meter, ((Number(w) || 0) * hours) / 1000000])
      )
    }
  })

  const summary = calculateByMeterConsumptionSummary(log)

  return { log, summary }
}

function calculateByMeterConsumptionSummary (log) {
  if (!log.length) {
    return {
      avgPowerW: null,
      totalConsumptionMWh: 0,
      groupedBy: {}
    }
  }

  const powerTotals = {}
  const powerCounts = {}
  const consumptionTotals = {}

  for (const entry of log) {
    const powerW = entry.powerW
    if (typeof powerW === 'object' && powerW !== null) {
      for (const [meter, val] of Object.entries(powerW)) {
        powerTotals[meter] = (powerTotals[meter] || 0) + (Number(val) || 0)
        powerCounts[meter] = (powerCounts[meter] || 0) + 1
      }
    }
    const consumptionMWh = entry.consumptionMWh
    if (typeof consumptionMWh === 'object' && consumptionMWh !== null) {
      for (const [meter, val] of Object.entries(consumptionMWh)) {
        consumptionTotals[meter] = (consumptionTotals[meter] || 0) + (Number(val) || 0)
      }
    }
  }

  const byGroup = {}
  let sitePowerTotal = 0
  let siteConsumptionTotal = 0
  for (const [meter, total] of Object.entries(powerTotals)) {
    byGroup[meter] = {
      avgPowerW: safeDiv(total, powerCounts[meter]),
      totalConsumptionMWh: consumptionTotals[meter] || 0
    }
    sitePowerTotal += total
    siteConsumptionTotal += consumptionTotals[meter] || 0
  }

  return {
    avgPowerW: safeDiv(sitePowerTotal, log.length),
    totalConsumptionMWh: siteConsumptionTotal,
    groupedBy: byGroup
  }
}

function calculateConsumptionSummary (log) {
  if (!log.length) {
    return {
      avgPowerW: null,
      totalConsumptionMWh: 0
    }
  }

  const totalPower = log.reduce((sum, entry) => sum + (entry.powerW || 0), 0)
  const totalConsumption = log.reduce((sum, entry) => sum + (entry.consumptionMWh || 0), 0)

  return {
    avgPowerW: safeDiv(totalPower, log.length),
    totalConsumptionMWh: totalConsumption
  }
}

const CONSUMPTION_GROUP_FIELDS = {
  miner: { field: LOG_FIELDS.POWER_W_TYPE_GROUP_SUM, aggrField: AGGR_FIELDS.POWER_W_TYPE_GROUP_SUM },
  container: { field: LOG_FIELDS.POWER_W_CONTAINER_GROUP_SUM, aggrField: AGGR_FIELDS.POWER_W_CONTAINER_GROUP_SUM },
  rack: { field: LOG_FIELDS.POWER_W_RACK_GROUP_SUM, aggrField: AGGR_FIELDS.POWER_W_RACK_GROUP_SUM }
}

async function getGroupedConsumption (ctx, req) {
  const { groupBy, start, end } = req.query

  const { field, aggrField } = CONSUMPTION_GROUP_FIELDS[groupBy]

  const res = await ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, {
    type: WORKER_TYPES.MINER,
    tag: WORKER_TAGS.MINER,
    key: LOG_KEYS.STAT_1D,
    start,
    end,
    fields: { [field]: 1 },
    aggrFields: { [aggrField]: 1 }
  })

  const rackFilter = groupBy === 'rack' ? rackFilterFor(parseRacks(req)) : null

  const log = res[0].reduce((aggr, val) => {
    let powerW = val[aggrField]
    if (rackFilter && powerW && typeof powerW === 'object') {
      powerW = Object.fromEntries(Object.entries(powerW).filter(([rack]) => rackFilter(rack)))
    }
    aggr.push({
      ts: parseEntryTs(val.ts),
      powerW,
      consumptionMWh: typeof powerW === 'object' && powerW !== null
        ? Object.fromEntries(
          Object.entries(powerW).map(([k, v]) => [k, (Number(v) || 0) * 24 / 1000000])
        )
        : null
    })
    return aggr
  }, [])

  const summary = calculateGroupedConsumptionSummary(log, groupBy)

  return { log, summary }
}

function calculateGroupedConsumptionSummary (log, groupBy) {
  if (!log.length) {
    return {
      avgPowerW: null,
      totalConsumptionMWh: 0
    }
  }

  const groupTotals = {}
  const groupCounts = {}

  for (const entry of log) {
    const powerW = entry.powerW
    if (typeof powerW === 'object' && powerW !== null) {
      for (const [name, val] of Object.entries(powerW)) {
        const v = Number(val) || 0
        groupTotals[name] = (groupTotals[name] || 0) + v
        groupCounts[name] = (groupCounts[name] || 0) + 1
      }
    }
  }

  const byGroup = {}
  let siteTotal = 0
  for (const [name, total] of Object.entries(groupTotals)) {
    const avgPowerW = safeDiv(total, groupCounts[name])
    byGroup[name] = {
      avgPowerW,
      totalConsumptionMWh: (total * 24) / 1000000
    }
    siteTotal += total
  }

  return {
    avgPowerW: safeDiv(siteTotal, log.length),
    totalConsumptionMWh: (siteTotal * 24) / 1000000,
    groupedBy: byGroup
  }
}

async function getEfficiency (ctx, req) {
  const { start, end } = validateStartEnd(req)

  if (req.query.groupBy) return getGroupedEfficiency(ctx, req)

  if (hasRackFilter(req)) {
    const { log } = await getGroupedEfficiency(ctx, rackGroupedReq(req))
    const scoped = log.map(({ ts, efficiencyWThs }) => ({ ts, efficiencyWThs: avgObjectValues(efficiencyWThs) }))
    return { log: scoped, summary: calculateEfficiencySummary(scoped) }
  }

  const { key, groupRange } = getIntervalConfig(resolveInterval(start, end, req.query.interval))

  // Central-DCS sites have no miner-reported site efficiency stat; derive it from
  // the DCS site meter (site_power_w) over miner hashrate
  if (isCentralDCSEnabled(ctx)) {
    return getDCSEfficiency(ctx, { key, groupRange, start, end })
  }

  const res = await ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, {
    type: WORKER_TYPES.MINER,
    tag: WORKER_TAGS.MINER,
    key,
    groupRange,
    shouldCalculateAvg: true,
    start,
    end,
    fields: { [LOG_FIELDS.EFFICIENCY]: 1 },
    aggrFields: { [AGGR_FIELDS.EFFICIENCY]: 1 }
  })

  const log = firstOrkEntries(res).map(val => {
    const timeRange = parseEntryTimeRange(val.ts)
    return {
      ts: parseEntryTs(val.ts),
      ...(timeRange && { timeRange }),
      efficiencyWThs: Number(val[AGGR_FIELDS.EFFICIENCY]) || 0
    }
  })

  const summary = calculateEfficiencySummary(log)

  return { log, summary }
}

// Site-meter efficiency (W/THs) per interval bucket: DCS site_power_w over total
// miner hashrate for the same bucket. Both series share the interval/groupRange
// so their timestamps align; we key hashrate by ts and divide per DCS power point.
async function getDCSEfficiency (ctx, { key, groupRange, start, end }) {
  const [powerRes, hashrateRes] = await Promise.all([
    ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, {
      type: WORKER_TYPES.DCS,
      tag: getDCSTag(ctx),
      key,
      groupRange,
      shouldCalculateAvg: true,
      start,
      end,
      fields: { [LOG_FIELDS.SITE_POWER]: 1 },
      aggrFields: { [AGGR_FIELDS.SITE_POWER]: 1 }
    }),
    ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, {
      type: WORKER_TYPES.MINER,
      tag: WORKER_TAGS.MINER,
      key,
      groupRange,
      shouldCalculateAvg: true,
      start,
      end,
      fields: { [LOG_FIELDS.HASHRATE_SUM]: 1 },
      aggrFields: { [AGGR_FIELDS.HASHRATE_SUM]: 1 }
    })
  ])

  const hashrateByTs = new Map()
  for (const val of firstOrkEntries(hashrateRes)) {
    hashrateByTs.set(val.ts, Number(val[AGGR_FIELDS.HASHRATE_SUM]) || 0)
  }

  const log = firstOrkEntries(powerRes).map(val => {
    const powerW = Number(val[AGGR_FIELDS.SITE_POWER]) || 0
    const hashrateThs = mhsToThs(hashrateByTs.get(val.ts) || 0)
    const timeRange = parseEntryTimeRange(val.ts)
    return {
      ts: parseEntryTs(val.ts),
      ...(timeRange && { timeRange }),
      efficiencyWThs: hashrateThs > 0 ? powerW / hashrateThs : 0
    }
  })

  const summary = calculateEfficiencySummary(log)

  return { log, summary }
}

function calculateEfficiencySummary (log) {
  if (!log.length) {
    return {
      avgEfficiencyWThs: null
    }
  }

  const total = log.reduce((sum, entry) => sum + (entry.efficiencyWThs || 0), 0)

  return {
    avgEfficiencyWThs: safeDiv(total, log.length)
  }
}

const EFFICIENCY_GROUP_FIELDS = {
  miner: { field: LOG_FIELDS.EFFICIENCY_TYPE_GROUP_AVG, aggrField: AGGR_FIELDS.EFFICIENCY_TYPE_GROUP_AVG },
  container: { field: LOG_FIELDS.EFFICIENCY_CONTAINER_GROUP_AVG, aggrField: AGGR_FIELDS.EFFICIENCY_CONTAINER_GROUP_AVG },
  rack: { field: LOG_FIELDS.EFFICIENCY_RACK_GROUP_AVG, aggrField: AGGR_FIELDS.EFFICIENCY_RACK_GROUP_AVG }
}

async function getGroupedEfficiency (ctx, req) {
  const { groupBy, start, end } = req.query

  const { field, aggrField } = EFFICIENCY_GROUP_FIELDS[groupBy]

  const res = await ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, {
    type: WORKER_TYPES.MINER,
    tag: WORKER_TAGS.MINER,
    key: LOG_KEYS.STAT_1D,
    start,
    end,
    fields: { [field]: 1 },
    aggrFields: { [aggrField]: 1 }
  })

  const rackFilter = groupBy === 'rack' ? rackFilterFor(parseRacks(req)) : null

  const log = firstOrkEntries(res).map((val) => {
    let efficiencyWThs = val[aggrField]
    if (rackFilter && efficiencyWThs && typeof efficiencyWThs === 'object') {
      efficiencyWThs = Object.fromEntries(Object.entries(efficiencyWThs).filter(([rack]) => rackFilter(rack)))
    }
    return { ts: parseEntryTs(val.ts), efficiencyWThs }
  })

  const summary = calculateGroupedEfficiencySummary(log, groupBy)

  return { log, summary }
}

function calculateGroupedEfficiencySummary (log, groupBy) {
  if (!log.length) {
    return {
      avgEfficiencyWThs: null
    }
  }

  const groupTotals = {}
  const groupCounts = {}

  for (const entry of log) {
    const efficiency = entry.efficiencyWThs
    if (typeof efficiency === 'object' && efficiency !== null) {
      for (const [name, val] of Object.entries(efficiency)) {
        const v = Number(val) || 0
        // efficiency is an average metric; skip empty readings so they
        // don't drag the group/site averages towards zero
        if (!v) continue
        groupTotals[name] = (groupTotals[name] || 0) + v
        groupCounts[name] = (groupCounts[name] || 0) + 1
      }
    }
  }

  const byGroup = {}
  let siteTotal = 0
  let siteCount = 0
  for (const [name, total] of Object.entries(groupTotals)) {
    byGroup[name] = {
      avgEfficiencyWThs: safeDiv(total, groupCounts[name])
    }
    siteTotal += total
    siteCount += groupCounts[name]
  }

  return {
    avgEfficiencyWThs: safeDiv(siteTotal, siteCount),
    groupedBy: byGroup
  }
}

async function getMinerStatus (ctx, req) {
  const { start, end } = validateStartEnd(req)

  if (req.query.groupBy) return getGroupedMinerStatus(ctx, req)

  const results = await ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, {
    key: LOG_KEYS.STAT_3H,
    type: WORKER_TYPES.MINER,
    tag: WORKER_TAGS.MINER,
    aggrFields: {
      [AGGR_FIELDS.TYPE_CNT]: 1,
      [AGGR_FIELDS.OFFLINE_CNT]: 1,
      [AGGR_FIELDS.SLEEP_CNT]: 1,
      [AGGR_FIELDS.MAINTENANCE_CNT]: 1,
      [AGGR_FIELDS.ERROR_CNT]: 1
    },
    groupRange: '1D',
    shouldCalculateAvg: true,
    start,
    end
  })

  const daily = processMinerStatusData(results)
  const log = Object.keys(daily).sort().map(dayTs => ({
    ts: Number(dayTs),
    ...daily[dayTs]
  }))

  const summary = calculateMinerStatusSummary(log)

  return { log, summary }
}

function processMinerStatusData (results) {
  const daily = {}
  for (const entry of iterateRpcEntries(results)) {
    const rawTs = parseEntryTs(entry.ts || entry.timestamp)
    const ts = rawTs ? getStartOfDay(rawTs) : null
    if (!ts) continue
    if (!daily[ts]) {
      daily[ts] = { online: 0, offline: 0, sleep: 0, maintenance: 0, error: 0 }
      const timeRange = parseEntryTimeRange(entry.ts || entry.timestamp)
      if (timeRange) daily[ts].timeRange = timeRange
    }

    const offlineCnt = sumObjectValues(entry[AGGR_FIELDS.OFFLINE_CNT] || entry.aggrFields?.[AGGR_FIELDS.OFFLINE_CNT])
    const sleepCnt = sumObjectValues(entry[AGGR_FIELDS.SLEEP_CNT] || entry.aggrFields?.[AGGR_FIELDS.SLEEP_CNT])
    const maintenanceCnt = sumObjectValues(entry[AGGR_FIELDS.MAINTENANCE_CNT] || entry.aggrFields?.[AGGR_FIELDS.MAINTENANCE_CNT])
    const errorCnt = sumObjectValues(entry[AGGR_FIELDS.ERROR_CNT] || entry.aggrFields?.[AGGR_FIELDS.ERROR_CNT])

    daily[ts].offline += offlineCnt
    daily[ts].sleep += sleepCnt
    daily[ts].maintenance += maintenanceCnt
    daily[ts].error += errorCnt

    const totalCount = sumObjectValues(entry[AGGR_FIELDS.TYPE_CNT]) || entry.total_cnt || entry.count || 0
    if (totalCount > 0) {
      daily[ts].online += Math.max(0, totalCount - offlineCnt - sleepCnt - maintenanceCnt - errorCnt)
    }
  }
  return daily
}

function calculateMinerStatusSummary (log) {
  if (!log.length) {
    return {
      avgOnline: null,
      avgOffline: null,
      avgSleep: null,
      avgMaintenance: null,
      avgError: null
    }
  }

  const totals = log.reduce((acc, entry) => {
    acc.online += entry.online || 0
    acc.offline += entry.offline || 0
    acc.sleep += entry.sleep || 0
    acc.maintenance += entry.maintenance || 0
    acc.error += entry.error || 0
    return acc
  }, { online: 0, offline: 0, sleep: 0, maintenance: 0, error: 0 })

  return {
    avgOnline: safeDiv(totals.online, log.length),
    avgOffline: safeDiv(totals.offline, log.length),
    avgSleep: safeDiv(totals.sleep, log.length),
    avgMaintenance: safeDiv(totals.maintenance, log.length),
    avgError: safeDiv(totals.error, log.length)
  }
}

const MINER_STATUS_TYPE_FIELDS = {
  total: AGGR_FIELDS.TYPE_CNT,
  offline: AGGR_FIELDS.OFFLINE_TYPE_CNT,
  sleep: AGGR_FIELDS.SLEEP_TYPE_CNT,
  maintenance: AGGR_FIELDS.MAINTENANCE_CNT,
  error: AGGR_FIELDS.ERROR_TYPE_CNT
}

async function getGroupedMinerStatus (ctx, req) {
  const { start, end } = req.query

  const aggrFields = {}
  for (const field of Object.values(MINER_STATUS_TYPE_FIELDS)) aggrFields[field] = 1

  const results = await ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, {
    key: LOG_KEYS.STAT_3H,
    type: WORKER_TYPES.MINER,
    tag: WORKER_TAGS.MINER,
    aggrFields,
    groupRange: '1D',
    shouldCalculateAvg: true,
    start,
    end
  })

  const daily = processGroupedMinerStatusData(results)
  const log = Object.keys(daily).sort().map(dayTs => ({
    ts: Number(dayTs),
    ...daily[dayTs]
  }))

  return { log }
}

function processGroupedMinerStatusData (results) {
  const daily = {}
  for (const entry of iterateRpcEntries(results)) {
    const rawTs = parseEntryTs(entry.ts || entry.timestamp)
    const ts = rawTs ? getStartOfDay(rawTs) : null
    if (!ts) continue
    if (!daily[ts]) {
      daily[ts] = { total: {}, online: {}, offline: {}, sleep: {}, maintenance: {}, error: {} }
      const timeRange = parseEntryTimeRange(entry.ts || entry.timestamp)
      if (timeRange) daily[ts].timeRange = timeRange
    }
    const bucket = daily[ts]
    mergeGroupedField(bucket.total, entry[AGGR_FIELDS.TYPE_CNT])
    mergeGroupedField(bucket.offline, entry[AGGR_FIELDS.OFFLINE_TYPE_CNT])
    mergeGroupedField(bucket.sleep, entry[AGGR_FIELDS.SLEEP_TYPE_CNT])
    mergeGroupedField(bucket.maintenance, entry[AGGR_FIELDS.MAINTENANCE_CNT])
    mergeGroupedField(bucket.error, entry[AGGR_FIELDS.ERROR_TYPE_CNT])
  }

  for (const bucket of Object.values(daily)) {
    for (const type of Object.keys(bucket.total)) {
      const online = bucket.total[type] - (bucket.offline[type] || 0) - (bucket.sleep[type] || 0) - (bucket.maintenance[type] || 0) - (bucket.error[type] || 0)
      bucket.online[type] = Math.max(0, online)
    }
  }
  return daily
}

const MINERS_BY_CONTAINER_AGGR_FIELDS = {
  [AGGR_FIELDS.HASHRATE_SUM_CONTAINER_GROUP_AGGR]: 1,
  [AGGR_FIELDS.POWER_W_CONTAINER_GROUP_SUM]: 1,
  [AGGR_FIELDS.EFFICIENCY_CONTAINER_GROUP_AVG]: 1,
  [AGGR_FIELDS.TEMP_MAX]: 1,
  [AGGR_FIELDS.TEMP_AVG]: 1,
  [AGGR_FIELDS.ACTIVE_CONTAINER_CNT]: 1,
  [AGGR_FIELDS.OFFLINE_CNT]: 1,
  [AGGR_FIELDS.ERROR_CNT]: 1,
  [AGGR_FIELDS.NOT_MINING_CNT]: 1,
  [AGGR_FIELDS.SLEEP_CNT]: 1,
  [AGGR_FIELDS.POWER_MODE_LOW_CNT]: 1,
  [AGGR_FIELDS.POWER_MODE_NORMAL_CNT]: 1,
  [AGGR_FIELDS.POWER_MODE_HIGH_CNT]: 1
}

async function getMinersByContainer (ctx, req) {
  const results = await ctx.dataProxy.requestDataMap(RPC_METHODS.TAIL_LOG_MULTI, {
    keys: [{ key: LOG_KEYS.STAT_RTD, type: WORKER_TYPES.MINER, tag: WORKER_TAGS.MINER }],
    limit: 1,
    aggrFields: MINERS_BY_CONTAINER_AGGR_FIELDS
  })

  return processMinersByContainer(results)
}

function processMinersByContainer (results) {
  const f = {
    hashrate: {},
    power: {},
    efficiency: {},
    tempMax: {},
    tempAvg: {},
    active: {},
    offline: {},
    error: {},
    notMining: {},
    sleep: {},
    low: {},
    normal: {},
    high: {}
  }

  for (const orkResult of results) {
    const entry = extractKeyEntry(orkResult, 0)
    if (!entry) continue
    mergeGroupedField(f.hashrate, entry[AGGR_FIELDS.HASHRATE_SUM_CONTAINER_GROUP_AGGR])
    mergeGroupedField(f.power, entry[AGGR_FIELDS.POWER_W_CONTAINER_GROUP_SUM])
    mergeGroupedField(f.efficiency, entry[AGGR_FIELDS.EFFICIENCY_CONTAINER_GROUP_AVG], true)
    mergeGroupedField(f.tempMax, entry[AGGR_FIELDS.TEMP_MAX], true)
    mergeGroupedField(f.tempAvg, entry[AGGR_FIELDS.TEMP_AVG], true)
    mergeGroupedField(f.active, entry[AGGR_FIELDS.ACTIVE_CONTAINER_CNT])
    mergeGroupedField(f.offline, entry[AGGR_FIELDS.OFFLINE_CNT])
    mergeGroupedField(f.error, entry[AGGR_FIELDS.ERROR_CNT])
    mergeGroupedField(f.notMining, entry[AGGR_FIELDS.NOT_MINING_CNT])
    mergeGroupedField(f.sleep, entry[AGGR_FIELDS.SLEEP_CNT])
    mergeGroupedField(f.low, entry[AGGR_FIELDS.POWER_MODE_LOW_CNT])
    mergeGroupedField(f.normal, entry[AGGR_FIELDS.POWER_MODE_NORMAL_CNT])
    mergeGroupedField(f.high, entry[AGGR_FIELDS.POWER_MODE_HIGH_CNT])
  }

  const containerIds = new Set()
  for (const field of Object.values(f)) {
    for (const id of Object.keys(field)) containerIds.add(id)
  }

  const containers = {}
  for (const id of containerIds) {
    const offlineCount = f.offline[id] || 0
    const errorCount = f.error[id] || 0
    const notMiningCount = f.notMining[id] || 0
    const sleepCount = f.sleep[id] || 0
    const low = f.low[id] || 0
    const normal = f.normal[id] || 0
    const high = f.high[id] || 0

    containers[id] = {
      minerCount: offlineCount + errorCount + notMiningCount + sleepCount + low + normal + high,
      onlineCount: f.active[id] || 0,
      offlineCount,
      errorCount,
      notMiningCount,
      sleepCount,
      powerMode: { low, normal, high },
      hashrateMhs: f.hashrate[id] || 0,
      powerW: f.power[id] || 0,
      efficiencyWThs: f.efficiency[id] || 0,
      temperatureC: { max: f.tempMax[id] ?? null, avg: f.tempAvg[id] ?? null }
    }
  }

  return { containers }
}

const INVENTORY_AGGR_FIELDS = {
  [AGGR_FIELDS.MINER_INVENTORY_STATUS]: 1,
  [AGGR_FIELDS.MINER_INVENTORY_LOCATION]: 1,
  [AGGR_FIELDS.SPARE_PARTS_CNT]: 1,
  [AGGR_FIELDS.SPARE_PART_INVENTORY_STATUS]: 1,
  [AGGR_FIELDS.SPARE_PART_INVENTORY_LOCATION]: 1
}

async function getInventorySummary (ctx, req) {
  const keys = [
    { key: LOG_KEYS.STAT_5M, type: WORKER_TYPES.MINER, tag: WORKER_TAGS.MINER },
    ...SPARE_PART_TYPES.map(type => ({ key: LOG_KEYS.STAT_5M, type: WORKER_TYPES.INVENTORY, tag: sparePartTag(type) }))
  ]

  const results = await ctx.dataProxy.requestDataMap(RPC_METHODS.TAIL_LOG_MULTI, {
    keys,
    limit: 1,
    start: Date.now() - SITE_STATUS_LIVE_WINDOW_MS,
    aggrFields: INVENTORY_AGGR_FIELDS
  })

  return processInventorySummary(results)
}

function processInventorySummary (results) {
  const miners = { byStatus: {}, byLocation: {} }
  const spareParts = {}
  for (const type of SPARE_PART_TYPES) spareParts[type] = { total: 0, byStatus: {}, byLocation: {} }

  for (const orkResult of results) {
    const minerEntry = extractKeyEntry(orkResult, 0)
    if (minerEntry) {
      mergeGroupedField(miners.byStatus, minerEntry[AGGR_FIELDS.MINER_INVENTORY_STATUS])
      mergeGroupedField(miners.byLocation, minerEntry[AGGR_FIELDS.MINER_INVENTORY_LOCATION])
    }

    SPARE_PART_TYPES.forEach((type, i) => {
      const entry = extractKeyEntry(orkResult, i + 1)
      if (!entry) return
      spareParts[type].total += Number(entry[AGGR_FIELDS.SPARE_PARTS_CNT]) || 0
      mergeGroupedField(spareParts[type].byStatus, entry[AGGR_FIELDS.SPARE_PART_INVENTORY_STATUS])
      mergeGroupedField(spareParts[type].byLocation, entry[AGGR_FIELDS.SPARE_PART_INVENTORY_LOCATION])
    })
  }

  return { miners, spareParts }
}

const MINERS_BY_TYPE_AGGR_FIELDS = {
  [AGGR_FIELDS.TYPE_CNT]: 1,
  [AGGR_FIELDS.POWER_W_TYPE_GROUP_SUM]: 1,
  [AGGR_FIELDS.OFFLINE_TYPE_CNT]: 1,
  [AGGR_FIELDS.ERROR_TYPE_CNT]: 1,
  [AGGR_FIELDS.MAINTENANCE_CNT]: 1,
  [AGGR_FIELDS.SLEEP_TYPE_CNT]: 1,
  [AGGR_FIELDS.POWER_MODE_LOW_TYPE_CNT]: 1,
  [AGGR_FIELDS.POWER_MODE_NORMAL_TYPE_CNT]: 1,
  [AGGR_FIELDS.POWER_MODE_HIGH_TYPE_CNT]: 1
}

async function getMinersByType (ctx, req) {
  const results = await ctx.dataProxy.requestDataMap(RPC_METHODS.TAIL_LOG_MULTI, {
    keys: [{ key: LOG_KEYS.STAT_5M, type: WORKER_TYPES.MINER, tag: WORKER_TAGS.MINER }],
    limit: 1,
    start: Date.now() - SITE_STATUS_LIVE_WINDOW_MS,
    aggrFields: MINERS_BY_TYPE_AGGR_FIELDS
  })

  return processMinersByType(results)
}

function processMinersByType (results) {
  const f = {
    count: {},
    powerW: {},
    offline: {},
    error: {},
    maintenance: {},
    sleep: {},
    low: {},
    normal: {},
    high: {}
  }

  for (const orkResult of results) {
    const entry = extractKeyEntry(orkResult, 0)
    if (!entry) continue
    mergeGroupedField(f.count, entry[AGGR_FIELDS.TYPE_CNT])
    mergeGroupedField(f.powerW, entry[AGGR_FIELDS.POWER_W_TYPE_GROUP_SUM])
    mergeGroupedField(f.offline, entry[AGGR_FIELDS.OFFLINE_TYPE_CNT])
    mergeGroupedField(f.error, entry[AGGR_FIELDS.ERROR_TYPE_CNT])
    mergeGroupedField(f.maintenance, entry[AGGR_FIELDS.MAINTENANCE_CNT])
    mergeGroupedField(f.sleep, entry[AGGR_FIELDS.SLEEP_TYPE_CNT])
    mergeGroupedField(f.low, entry[AGGR_FIELDS.POWER_MODE_LOW_TYPE_CNT])
    mergeGroupedField(f.normal, entry[AGGR_FIELDS.POWER_MODE_NORMAL_TYPE_CNT])
    mergeGroupedField(f.high, entry[AGGR_FIELDS.POWER_MODE_HIGH_TYPE_CNT])
  }

  const minerTypes = new Set()
  for (const field of Object.values(f)) {
    for (const type of Object.keys(field)) minerTypes.add(type)
  }

  const types = {}
  for (const type of minerTypes) {
    types[type] = {
      count: f.count[type] || 0,
      powerW: f.powerW[type] || 0,
      offline: f.offline[type] || 0,
      error: f.error[type] || 0,
      maintenance: f.maintenance[type] || 0,
      powerModes: {
        sleep: f.sleep[type] || 0,
        low: f.low[type] || 0,
        normal: f.normal[type] || 0,
        high: f.high[type] || 0
      }
    }
  }

  return { types }
}

const CONTAINER_MINER_TAG_REGEX = /container_miner-[^_]+_(.+)/

function computeInstalledCapacity (containers, byContainer) {
  const capacity = {}
  for (const container of containers) {
    const tags = Array.isArray(container?.tags) ? container.tags : []
    const minerTag = tags.find(tag => typeof tag === 'string' && tag.startsWith('container_miner'))
    const match = minerTag && minerTag.match(CONTAINER_MINER_TAG_REGEX)
    if (!match) continue

    const minerType = `miner-${match[1]}`
    const total = Number(container.info?.nominalMinerCapacity) || 0
    const entry = byContainer?.[container.info?.container]
    const connected = entry ? entry.minerCount : 0
    const available = Math.max(0, total - connected)

    if (!capacity[minerType]) capacity[minerType] = { total: 0, available: 0 }
    capacity[minerType].total += total
    capacity[minerType].available += available
  }
  return capacity
}

async function getInventoryMinerDistribution (ctx, req) {
  const site = ctx.conf?.site
  const minersQuery = site
    ? { $and: [{ 'info.site': { $eq: site } }, { tags: { $in: [WORKER_TAGS.MINER] } }] }
    : { tags: { $in: [WORKER_TAGS.MINER] } }

  const [minerResults, containerResults, byContainer] = await Promise.all([
    ctx.dataProxy.requestDataAllPages(RPC_METHODS.LIST_THINGS, {
      query: minersQuery,
      fields: { id: 1, type: 1 },
      status: 1
    }),
    ctx.dataProxy.requestDataAllPages(RPC_METHODS.LIST_THINGS, {
      query: { tags: { $in: [WORKER_TAGS.CONTAINER] } },
      fields: { id: 1, tags: 1, 'info.container': 1, 'info.nominalMinerCapacity': 1 },
      status: 1
    }),
    getMinersByContainer(ctx, req)
  ])

  const miners = flattenRpcResults(minerResults)
  const countByType = {}
  for (const miner of miners) {
    if (miner?.type) countByType[miner.type] = (countByType[miner.type] || 0) + 1
  }
  const minerTypes = Object.keys(countByType).sort()

  const locationResults = minerTypes.length
    ? await ctx.dataProxy.requestDataMap(RPC_METHODS.TAIL_LOG_MULTI, {
      keys: minerTypes.map(type => ({
        key: LOG_KEYS.STAT_5M,
        type: WORKER_TYPES.MINER,
        tag: `t-${type}`
      })),
      limit: 1,
      start: Date.now() - SITE_STATUS_LIVE_WINDOW_MS,
      aggrFields: { [AGGR_FIELDS.MINER_INVENTORY_LOCATION]: 1 }
    })
    : []

  const locationsByType = {}
  for (const orkResult of locationResults) {
    minerTypes.forEach((type, keyIndex) => {
      const entry = extractKeyEntry(orkResult, keyIndex)
      if (!entry) return
      if (!locationsByType[type]) locationsByType[type] = {}
      mergeGroupedField(locationsByType[type], entry[AGGR_FIELDS.MINER_INVENTORY_LOCATION])
    })
  }

  const capacityByType = computeInstalledCapacity(flattenRpcResults(containerResults), byContainer.containers)

  const rows = minerTypes.map(type => {
    const locations = {}
    let knownSum = 0
    for (const [location, count] of Object.entries(locationsByType[type] || {})) {
      if (location === 'unknown') continue
      locations[location] = count
      knownSum += count
    }
    locations.unknown = Math.max(0, countByType[type] - knownSum)

    return {
      type,
      count: countByType[type],
      totalPositions: capacityByType[type] ? capacityByType[type].total : null,
      freePositions: capacityByType[type] ? capacityByType[type].available : null,
      locations
    }
  })

  return { rows, totalMiners: miners.length }
}

async function getPowerMode (ctx, req) {
  const { start, end } = validateStartEnd(req)

  const interval = resolveInterval(start, end, req.query.interval)
  const config = getIntervalConfig(interval)

  const rpcPayload = {
    key: config.key,
    type: WORKER_TYPES.MINER,
    tag: WORKER_TAGS.MINER,
    aggrFields: {
      [AGGR_FIELDS.POWER_MODE_GROUP]: 1,
      [AGGR_FIELDS.STATUS_GROUP]: 1
    },
    start,
    end
  }

  if (config.groupRange) {
    rpcPayload.groupRange = config.groupRange
  }

  const results = await ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, rpcPayload)

  const timePoints = processPowerModeData(results, config.groupRange)
  const log = Object.keys(timePoints).sort().map(ts => ({
    ts: Number(ts),
    ...timePoints[ts]
  }))

  const summary = calculatePowerModeSummary(log)

  return { log, summary }
}

function categorizeMiner (powerMode, status) {
  if (status === 'offline') return MINER_CATEGORIES.OFFLINE
  if (status === 'error') return MINER_CATEGORIES.ERROR
  if (status === 'maintenance') return MINER_CATEGORIES.MAINTENANCE
  if (status === 'idle' || status === 'stopped') return MINER_CATEGORIES.NOT_MINING
  if (powerMode === 'low') return MINER_CATEGORIES.LOW
  if (powerMode === 'high') return MINER_CATEGORIES.HIGH
  if (powerMode === 'sleep') return MINER_CATEGORIES.SLEEP
  return powerMode || MINER_CATEGORIES.NORMAL
}

function processPowerModeData (results, groupRange) {
  const timePoints = {}
  const emptyPoint = () => ({ low: 0, normal: 0, high: 0, sleep: 0, offline: 0, notMining: 0, maintenance: 0, error: 0 })

  for (const entry of iterateRpcEntries(results)) {
    // Grouped entries carry the bucket-start ts (already aligned to the group
    // range), so use it directly rather than collapsing to the start of the day.
    const ts = parseEntryTs(entry.ts || entry.timestamp)
    if (!ts) continue

    if (!timePoints[ts]) {
      timePoints[ts] = emptyPoint()
      const timeRange = parseEntryTimeRange(entry.ts || entry.timestamp)
      if (timeRange) timePoints[ts].timeRange = timeRange
    }

    const powerModeObj = entry[AGGR_FIELDS.POWER_MODE_GROUP] || entry.aggrFields?.[AGGR_FIELDS.POWER_MODE_GROUP] || {}
    const statusObj = entry[AGGR_FIELDS.STATUS_GROUP] || entry.aggrFields?.[AGGR_FIELDS.STATUS_GROUP] || {}

    if (typeof powerModeObj === 'object' && powerModeObj !== null) {
      for (const [minerId, mode] of Object.entries(powerModeObj)) {
        const minerStatus = statusObj[minerId] || ''
        const category = categorizeMiner(mode, minerStatus)
        timePoints[ts][category] = (timePoints[ts][category] || 0) + 1
      }
    }
  }
  return timePoints
}

function calculatePowerModeSummary (log) {
  const categories = ['low', 'normal', 'high', 'sleep', 'offline', 'notMining', 'maintenance', 'error']
  if (!log.length) {
    const summary = {}
    for (const cat of categories) {
      summary['avg' + cat.charAt(0).toUpperCase() + cat.slice(1)] = null
    }
    return summary
  }

  const totals = {}
  for (const cat of categories) totals[cat] = 0
  for (const entry of log) {
    for (const cat of categories) {
      totals[cat] += entry[cat] || 0
    }
  }

  const summary = {}
  for (const cat of categories) {
    summary['avg' + cat.charAt(0).toUpperCase() + cat.slice(1)] = safeDiv(totals[cat], log.length)
  }
  return summary
}

const POWER_MODE_TIMELINE_INTERVALS = {
  '1m': { key: LOG_KEYS.STAT_1M, stepMs: 60 * 1000 },
  '5m': { key: LOG_KEYS.STAT_5M, stepMs: 5 * 60 * 1000 },
  '30m': { key: LOG_KEYS.STAT_30M, stepMs: 30 * 60 * 1000 },
  '3h': { key: LOG_KEYS.STAT_3H, stepMs: METRICS_TIME.THREE_HOURS_MS }
}

function resolvePowerModeTimelineInterval (start, end, requested) {
  if (requested && POWER_MODE_TIMELINE_INTERVALS[requested]) return requested
  const range = end - start
  if (range <= METRICS_TIME.SEVEN_DAYS_MS) return '1m'
  if (range <= METRICS_TIME.ONE_MONTH_MS) return '30m'
  return '3h'
}

async function getPowerModeTimeline (ctx, req) {
  const now = Date.now()
  const start = Number(req.query.start) || (now - METRICS_TIME.ONE_MONTH_MS)
  const end = Number(req.query.end) || now
  const container = req.query.container || null

  if (start >= end) {
    throw new Error('ERR_INVALID_DATE_RANGE')
  }

  const interval = resolvePowerModeTimelineInterval(start, end, req.query.interval)
  const { key, stepMs } = POWER_MODE_TIMELINE_INTERVALS[interval]
  const windowMs = stepMs * METRICS_DEFAULTS.POWER_MODE_TIMELINE_WINDOW_SAMPLES

  const aggregator = createPowerModeTimelineAggregator(container)

  for (let windowStart = start; windowStart < end; windowStart += windowMs) {
    const windowEnd = Math.min(windowStart + windowMs, end)

    const results = await ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, {
      key,
      type: WORKER_TYPES.MINER,
      tag: WORKER_TAGS.MINER,
      aggrFields: {
        [AGGR_FIELDS.POWER_MODE_GROUP]: 1,
        [AGGR_FIELDS.STATUS_GROUP]: 1
      },
      start: windowStart,
      end: windowEnd,
      limit: Math.ceil((windowEnd - windowStart) / stepMs) + 1
    })

    aggregator.addResults(results)
  }

  return { log: aggregator.build(), interval }
}

// Segments are folded incrementally so memory scales with the number of mode
// changes, not with samples x fleet size. Callers must feed results in
// ascending time-window order.
function createPowerModeTimelineAggregator (containerFilter) {
  const minerStates = new Map()
  const minerContainers = new Map()

  const minerContainer = (minerId) => {
    let container = minerContainers.get(minerId)
    if (container === undefined) {
      container = extractContainerFromMinerKey(minerId)
      minerContainers.set(minerId, container)
    }
    return container
  }

  const addSample = (minerId, ts, powerMode, status) => {
    if (containerFilter && minerContainer(minerId) !== containerFilter) return

    let state = minerStates.get(minerId)
    if (!state) {
      state = { segments: [], current: null }
      minerStates.set(minerId, state)
    }

    const current = state.current
    if (!current || current.powerMode !== powerMode || current.status !== status) {
      if (current) {
        current.to = ts
        state.segments.push(current)
      }
      state.current = { from: ts, to: ts, powerMode, status }
    } else {
      current.to = ts
    }
  }

  return {
    addResults (results) {
      const entries = []
      for (const entry of iterateRpcEntries(results)) {
        const ts = parseEntryTs(entry.ts || entry.timestamp)
        if (!ts) continue
        entries.push({ ts, entry })
      }
      entries.sort((a, b) => a.ts - b.ts)

      for (const { ts, entry } of entries) {
        const powerModeObj = entry[AGGR_FIELDS.POWER_MODE_GROUP] || entry.aggrFields?.[AGGR_FIELDS.POWER_MODE_GROUP] || {}
        const statusObj = entry[AGGR_FIELDS.STATUS_GROUP] || entry.aggrFields?.[AGGR_FIELDS.STATUS_GROUP] || {}

        const powerModes = (typeof powerModeObj === 'object' && powerModeObj !== null) ? powerModeObj : {}
        const statuses = (typeof statusObj === 'object' && statusObj !== null) ? statusObj : {}

        for (const minerId of Object.keys(statuses)) {
          addSample(minerId, ts, powerModes[minerId] || statuses[minerId] || 'unknown', statuses[minerId] || 'unknown')
        }
        for (const minerId of Object.keys(powerModes)) {
          if (!(minerId in statuses)) {
            addSample(minerId, ts, powerModes[minerId] || 'unknown', 'unknown')
          }
        }
      }
    },

    build () {
      const log = []
      for (const [minerId, state] of minerStates) {
        const segments = state.current
          ? [...state.segments, state.current]
          : state.segments
        log.push({ minerId, container: minerContainer(minerId), segments })
      }
      return log
    }
  }
}

function processPowerModeTimelineData (results, containerFilter) {
  const aggregator = createPowerModeTimelineAggregator(containerFilter)
  aggregator.addResults(results)
  return aggregator.build()
}

async function getTemperature (ctx, req) {
  const { start, end } = validateStartEnd(req)

  const interval = resolveInterval(start, end, req.query.interval)
  const config = getIntervalConfig(interval)
  const container = req.query.container || null

  const rpcPayload = {
    key: config.key,
    type: WORKER_TYPES.MINER,
    tag: WORKER_TAGS.MINER,
    aggrFields: {
      [AGGR_FIELDS.TEMP_MAX]: 1,
      [AGGR_FIELDS.TEMP_AVG]: 1
    },
    shouldCalculateAvg: true,
    start,
    end
  }

  if (config.groupRange) {
    rpcPayload.groupRange = config.groupRange
  }

  const results = await ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, rpcPayload)

  const timePoints = processTemperatureData(results, config.groupRange, container)
  const log = Object.keys(timePoints).sort().map(ts => ({
    ts: Number(ts),
    ...timePoints[ts]
  }))

  const summary = calculateTemperatureSummary(log)

  return { log, summary }
}

function processTemperatureData (results, groupRange, containerFilter) {
  const timePoints = {}
  const avgCounts = {}

  for (const entry of iterateRpcEntries(results)) {
    // Grouped entries carry the bucket-start ts (already aligned to the group
    // range), so use it directly rather than collapsing to the start of the day.
    const ts = parseEntryTs(entry.ts || entry.timestamp)
    if (!ts) continue

    const maxObj = entry[AGGR_FIELDS.TEMP_MAX] || entry.aggrFields?.[AGGR_FIELDS.TEMP_MAX] || {}
    const avgObj = entry[AGGR_FIELDS.TEMP_AVG] || entry.aggrFields?.[AGGR_FIELDS.TEMP_AVG] || {}

    if (!timePoints[ts]) {
      timePoints[ts] = { containers: {}, siteMaxC: null, siteAvgC: null }
      const timeRange = parseEntryTimeRange(entry.ts || entry.timestamp)
      if (timeRange) timePoints[ts].timeRange = timeRange
      avgCounts[ts] = {}
    }

    const point = timePoints[ts]

    if (typeof maxObj === 'object' && maxObj !== null) {
      for (const [name, maxVal] of Object.entries(maxObj)) {
        if (containerFilter && name !== containerFilter) continue
        const numMax = Number(maxVal) || 0
        const numAvg = Number(avgObj[name]) || 0

        if (!point.containers[name]) {
          point.containers[name] = { maxC: numMax, avgC: numAvg }
          avgCounts[ts][name] = 1
        } else {
          point.containers[name].maxC = Math.max(point.containers[name].maxC, numMax)
          const count = avgCounts[ts][name]
          point.containers[name].avgC = (point.containers[name].avgC * count + numAvg) / (count + 1)
          avgCounts[ts][name] = count + 1
        }
      }
    }

    const containerVals = Object.values(point.containers)
    if (containerVals.length) {
      point.siteMaxC = Math.max(...containerVals.map(c => c.maxC))
      const avgSum = containerVals.reduce((sum, c) => sum + c.avgC, 0)
      point.siteAvgC = safeDiv(avgSum, containerVals.length)
    }
  }
  return timePoints
}

function calculateTemperatureSummary (log) {
  if (!log.length) {
    return {
      avgMaxTemp: null,
      avgAvgTemp: null,
      peakTemp: null
    }
  }

  const maxTemps = log.filter(e => e.siteMaxC !== null).map(e => e.siteMaxC)
  const avgTemps = log.filter(e => e.siteAvgC !== null).map(e => e.siteAvgC)

  return {
    avgMaxTemp: maxTemps.length ? safeDiv(maxTemps.reduce((a, b) => a + b, 0), maxTemps.length) : null,
    avgAvgTemp: avgTemps.length ? safeDiv(avgTemps.reduce((a, b) => a + b, 0), avgTemps.length) : null,
    peakTemp: maxTemps.length ? Math.max(...maxTemps) : null
  }
}

async function getContainerTelemetry (ctx, req) {
  const containerId = req.params.id

  if (!containerId) {
    throw new Error('ERR_MISSING_CONTAINER_ID')
  }

  const containerTag = `container-${containerId}`

  const [minersResults, sensorResults] = await Promise.all([
    ctx.dataProxy.requestDataAllPages(RPC_METHODS.LIST_THINGS, {
      query: { tags: { $in: [containerTag] } },
      fields: DEVICE_LIST_FIELDS
    }),
    ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, {
      key: LOG_KEYS.STAT_5M,
      type: WORKER_TYPES.CONTAINER,
      tag: WORKER_TAGS.CONTAINER,
      aggrFields: {
        [AGGR_FIELDS.CONTAINER_SPECIFIC_STATS]: 1
      },
      limit: 1
    })
  ])

  const miners = processContainerMiners(minersResults)
  const telemetry = processContainerSensorSnapshot(sensorResults, containerId)

  return {
    id: containerId,
    miners,
    telemetry
  }
}

function processContainerMiners (results) {
  const miners = []
  for (const res of results) {
    if (!res || res.error) continue
    const data = Array.isArray(res) ? res : (res.data || res.result || [])
    if (!Array.isArray(data)) continue
    for (const thing of data) {
      if (!thing || thing.error) continue
      miners.push(thing)
    }
  }
  return miners
}

function processContainerSensorSnapshot (results, containerId) {
  for (const entry of iterateRpcEntries(results)) {
    const aggrData = entry[AGGR_FIELDS.CONTAINER_SPECIFIC_STATS] ||
      entry.aggrFields?.[AGGR_FIELDS.CONTAINER_SPECIFIC_STATS] || {}

    if (typeof aggrData !== 'object' || aggrData === null) continue

    if (aggrData[containerId]) {
      return aggrData[containerId]
    }

    for (const [key, val] of Object.entries(aggrData)) {
      if (key.startsWith(containerId)) {
        return val
      }
    }
  }
  return null
}

// Container racks schedule these timeframes on top of the thing defaults
// (rack.container.wrk.js: 20s, 1m, rtd).
const CONTAINER_HISTORY_KEYS = {
  '20s': LOG_KEYS.STAT_20S,
  '1m': LOG_KEYS.STAT_1M,
  '5m': LOG_KEYS.STAT_5M,
  '30m': LOG_KEYS.STAT_30M,
  '3h': LOG_KEYS.STAT_3H,
  '1d': LOG_KEYS.STAT_1D
}

async function getContainerHistory (ctx, req) {
  const containerId = req.params.id

  if (!containerId) {
    throw new Error('ERR_MISSING_CONTAINER_ID')
  }

  const now = Date.now()
  const start = Number(req.query.start) || (now - METRICS_TIME.ONE_DAY_MS)
  const end = Number(req.query.end) || now
  const limit = Number(req.query.limit) || METRICS_DEFAULTS.CONTAINER_HISTORY_LIMIT

  if (start >= end) {
    throw new Error('ERR_INVALID_DATE_RANGE')
  }

  const results = await ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, {
    key: CONTAINER_HISTORY_KEYS[req.query.interval] || LOG_KEYS.STAT_5M,
    type: WORKER_TYPES.CONTAINER,
    tag: WORKER_TAGS.CONTAINER,
    aggrFields: {
      [AGGR_FIELDS.CONTAINER_SPECIFIC_STATS]: 1
    },
    start,
    end,
    limit
  })

  const log = processContainerHistoryData(results, containerId)

  return { log }
}

function processContainerHistoryData (results, containerId) {
  const log = []

  for (const entry of iterateRpcEntries(results)) {
    const ts = parseEntryTs(entry.ts || entry.timestamp)
    if (!ts) continue

    const aggrData = entry[AGGR_FIELDS.CONTAINER_SPECIFIC_STATS] ||
      entry.aggrFields?.[AGGR_FIELDS.CONTAINER_SPECIFIC_STATS] || {}

    if (typeof aggrData !== 'object' || aggrData === null) continue

    let containerData = aggrData[containerId] || null

    if (!containerData) {
      for (const [key, val] of Object.entries(aggrData)) {
        if (key.startsWith(containerId)) {
          containerData = val
          break
        }
      }
    }

    if (containerData) {
      log.push({ ts, ...containerData })
    }
  }

  log.sort((a, b) => a.ts - b.ts)
  return log
}

const COOLING_INTERVAL_ALIASES = { hourly: '1h', daily: '1d', weekly: '1w' }

const round1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10)

async function getCooling (ctx, req) {
  if (!isCentralDCSEnabled(ctx)) {
    throw new Error('ERR_FEATURE_NOT_ENABLED')
  }

  const { start, end } = validateStartEnd(req)

  const requested = COOLING_INTERVAL_ALIASES[req.query.interval] || req.query.interval
  const interval = resolveInterval(start, end, requested)
  const config = getIntervalConfig(interval)

  const rpcPayload = {
    key: config.key,
    type: WORKER_TYPES.DCS,
    tag: getDCSTag(ctx),
    aggrFields: COOLING_METRICS_AGGR_FIELDS,
    start,
    end
  }
  if (config.groupRange) {
    rpcPayload.groupRange = config.groupRange
  }

  const results = await ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, rpcPayload)

  const log = processCoolingData(results, config.groupRange)
  const summary = calculateCoolingSummary(log)

  return { interval, log, summary }
}

function processCoolingData (results, groupRange) {
  const points = []
  for (const entry of iterateRpcEntries(results)) {
    // Grouped entries carry the bucket-start ts (already aligned to the group
    // range), so use it directly rather than collapsing to the start of the day.
    const ts = parseEntryTs(entry.ts || entry.timestamp)
    if (!ts) continue

    const read = (field) => {
      const v = entry[field] ?? entry.aggrFields?.[field]
      return v == null || !Number.isFinite(Number(v)) ? null : Number(v)
    }

    const supply = read('miner_supply_temp_c')
    const ret = read('miner_return_temp_c')
    const chillerRunning = read('chiller_running')
    const timeRange = parseEntryTimeRange(entry.ts || entry.timestamp)

    points.push({
      ts: Number(ts),
      ...(timeRange && { timeRange }),
      minerSupplyTempC: round1(supply),
      minerReturnTempC: round1(ret),
      minerDeltaTC: (supply != null && ret != null) ? round1(ret - supply) : null,
      minerFlowM3h: round1(read('miner_flow_m3h')),
      systemPressureBar: round1(read('system_pressure_bar')),
      hvacSupplyTempC: round1(read('hvac_supply_temp_c')),
      hvacReturnTempC: round1(read('hvac_return_temp_c')),
      chillerUptimePct: chillerRunning == null ? null : Math.round(chillerRunning * 1000) / 10,
      towersRunning: round1(read('towers_running')),
      pumpsRunning: round1(read('pumps_running'))
    })
  }
  return points.sort((a, b) => a.ts - b.ts)
}

function calculateCoolingSummary (log) {
  const avgOf = (key) => {
    const vals = log.map(e => e[key]).filter(v => v != null)
    return vals.length ? round1(vals.reduce((a, b) => a + b, 0) / vals.length) : null
  }
  return {
    avgMinerSupplyTempC: avgOf('minerSupplyTempC'),
    avgMinerReturnTempC: avgOf('minerReturnTempC'),
    avgMinerDeltaTC: avgOf('minerDeltaTC'),
    avgMinerFlowM3h: avgOf('minerFlowM3h'),
    avgSystemPressureBar: avgOf('systemPressureBar'),
    avgHvacSupplyTempC: avgOf('hvacSupplyTempC'),
    avgHvacReturnTempC: avgOf('hvacReturnTempC'),
    chillerUptimePct: avgOf('chillerUptimePct')
  }
}

module.exports = {
  ...require('../../metrics.utils'),
  getHashrate,
  calculateHashrateSummary,
  calculateGroupedHashrateSummary,
  getConsumption,
  calculateConsumptionSummary,
  calculateByMeterConsumptionSummary,
  calculateGroupedConsumptionSummary,
  getEfficiency,
  calculateEfficiencySummary,
  getGroupedEfficiency,
  calculateGroupedEfficiencySummary,
  getMinerStatus,
  processMinerStatusData,
  calculateMinerStatusSummary,
  getGroupedMinerStatus,
  processGroupedMinerStatusData,
  getMinersByContainer,
  processMinersByContainer,
  getInventorySummary,
  processInventorySummary,
  getMinersByType,
  processMinersByType,
  getInventoryMinerDistribution,
  computeInstalledCapacity,
  getPowerMode,
  processPowerModeData,
  calculatePowerModeSummary,
  categorizeMiner,
  getPowerModeTimeline,
  processPowerModeTimelineData,
  resolvePowerModeTimelineInterval,
  getTemperature,
  processTemperatureData,
  calculateTemperatureSummary,
  getContainerTelemetry,
  processContainerMiners,
  processContainerSensorSnapshot,
  getContainerHistory,
  processContainerHistoryData,
  getCooling,
  processCoolingData,
  calculateCoolingSummary
}
