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
  SITE_STATUS_LIVE_WINDOW_MS,
  ELECTRICITY_EXT_DATA_KEYS,
  MINERPOOL_EXT_DATA_KEYS,
  POOL_HASHRATE_INTERVALS_MS
} = require('../../constants')
const {
  localDayStart,
  nextLocalDayStart,
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
  resolveStartEnd,
  resolveTimezone,
  resolveOptionalTimeMs,
  iterateRpcEntries,
  sumObjectValues,
  extractContainerFromMinerKey,
  resolveInterval,
  getIntervalConfig,
  mergeGroupedField,
  extractKeyEntry,
  rollupLocalMonths,
  isLocalInterval,
  groupLocalBuckets,
  localMonthsInRange,
  localMonthKey,
  mhsToThs,
  rackFilterFor
} = require('../../metrics.utils')
const { parseRacks } = require('../lib/queryUtils')
const { assertTimezone } = require('../lib/export/mappers')
const { createMonthlyHashesCache } = require('../lib/monthlyHashesCache')
const { phaseHourlyCache, phaseHourlyCacheKey, phaseHourlyGeneration } = require('../lib/phaseConsumptionCache')
const lPhases = require('../../phases.utils')
const { resolvePoolHashrateForBuckets } = require('./pools.handlers')
const { getEnergyConsumption } = require('./energy.handlers')
const { extractGlobalConfig } = require('./site.utils')
const { normalizeAvailability } = require('../lib/export/types/forecast.export')

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

function hashrateAggrField (container) {
  return container ? AGGR_FIELDS.HASHRATE_SUM_CONTAINER_GROUP_AGGR : AGGR_FIELDS.HASHRATE_SUM
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

function pageHashrate (req, { log, summary }) {
  const offset = Number(req.query.offset) || 0
  const limit = Number(req.query.limit) || undefined
  const reverse = req.query.reverse === true || req.query.reverse === 'true'
  const sorted = log.slice().sort((a, b) => reverse ? b.ts - a.ts : a.ts - b.ts)

  return {
    log: limit ? sorted.slice(offset, offset + limit) : sorted.slice(offset),
    totalCount: log.length,
    summary
  }
}

const monthlyHashesCache = createMonthlyHashesCache()
const dailyHashesCache = createMonthlyHashesCache()

// A calendar month is rolled up from hourly buckets, so it is only offered for the
// series that HAS hourly buckets: the site-wide one, optionally scoped to a container.
// A grouped or rack-scoped request gets its local months from getGoupedHashrate instead,
// where there is no per-hour pool pairing to roll up and an "hours reported" count would lie.
function wantsMonthlyRollup (req) {
  return req.query.interval === '1M' && !req.query.groupBy && !hasRackFilter(req)
}

// Local days are rolled up from hourly buckets exactly like calendar months, so whole
// months of day rows are reusable the same way - and only for the same ungrouped series.
function wantsDailyRollup (req) {
  return req.query.interval === '1d' && !req.query.groupBy && !hasRackFilter(req)
}

async function getHashrate (ctx, req) {
  const phase = lPhases.resolvePhase(ctx, req)

  // '1M' means a calendar-month rollup, as it already does for consumption - not the
  // store's rolling-30-day bucket that getIntervalConfig would hand back for it.
  if (wantsMonthlyRollup(req)) return getMonthlyHashrate(ctx, req, phase)

  if (wantsDailyRollup(req)) return pageHashrate(req, await getDailyHashrate(ctx, req, phase))

  return pageHashrate(req, await resolveHashrate(ctx, req, phase))
}

/**
 * Calendar months instead of raw buckets, cut in the resolved zone: the request's
 * `timezone`, else the site's lockedTimezone (invoicing bills the site's own month).
 *
 * The store cannot bucket by calendar month (groupRange '1M' is a rolling 30 days)
 * and its daily buckets are UTC-aligned, so a month is still built from hourly ones -
 * but rolling them up HERE means the caller receives a handful of rows instead of the
 * ~8,760 buckets a year of hours costs to ship and re-aggregate.
 *
 * Months that have ended are served from a per-process cache, so a repeat request
 * only recomputes the running month. Months the site reported nothing for are absent
 * rather than zero-filled; the caller knows the window it asked for and can say so.
 */
async function getMonthlyHashrate (ctx, req, phase = null) {
  const { start, end } = validateStartEnd(req)
  // A zone the runtime does not know throws a raw RangeError out of Intl; the exports
  // already turn that into a named 400, so the endpoint answers the same way. Without
  // one, months are cut in the site's zone, as every other local bucketing is.
  const timezone = req.query.timezone ? assertTimezone(req.query.timezone) : resolveTimezone(ctx, req)
  const now = Date.now()
  const flags = {
    nominal: req.query.nominal === true || req.query.nominal === 'true',
    siteNominal: req.query.siteNominal === true || req.query.siteNominal === 'true',
    pool: req.query.pool === true || req.query.pool === 'true',
    container: req.query.container || null,
    phase: phase?.id || null
  }

  const months = localMonthsInRange(start, end, timezone)
  // Only a month the request covers end to end is the month itself; a partial edge
  // month is a slice of one, and must neither be stored as the whole nor answered
  // with it. The running month still gains hours, so it is never cached either.
  const cacheable = (month) => month.end < now && month.start >= start && month.end <= end
  // overwriteCache skips cached months but still stores the fresh rollup, so a backfilled
  // month is not served stale for the rest of the TTL.
  const refresh = !!req.query.overwriteCache
  const rows = new Map()
  const missing = []

  for (const month of months) {
    const cached = cacheable(month) && !refresh
      ? monthlyHashesCache.get(monthlyHashesCache.key(month.key, timezone, flags), now)
      : undefined

    if (cached !== undefined) rows.set(month.key, cached)
    else missing.push(month)
  }

  if (missing.length) {
    // One query over the span the misses cover, clamped to what was actually asked
    // for: the first and last month of a range are usually partial.
    const span = {
      start: Math.max(start, missing[0].start),
      end: Math.min(end, missing[missing.length - 1].end)
    }
    // A window ending exactly on a month boundary leaves a zero-width edge month
    // once the earlier months are answered from cache; validateStartEnd rejects
    // it, and stepping back one millisecond cannot add a bucket.
    if (span.end === span.start) span.start -= 1
    const { log } = await resolveHashrate(ctx, {
      ...req,
      query: { ...req.query, ...span, interval: '1h' }
    }, phase)

    for (const row of rollupLocalMonths(log, timezone)) {
      rows.set(localMonthKey(row.ts, timezone), row)
    }

    // A completed month the site never reported is cached as null, not skipped: it
    // produces no row to cache, so leaving it out keeps it permanently missing and
    // the query span keeps stretching back over it on every request.
    for (const month of missing) {
      if (!cacheable(month)) continue

      const key = monthlyHashesCache.key(month.key, timezone, flags)
      monthlyHashesCache.set(key, rows.get(month.key) ?? null, now)
    }
  }

  const log = months.map((month) => rows.get(month.key)).filter(Boolean)
  const summary = calculateHashrateSummary(log, flags.nominal)

  // The same summary fields the other intervals carry: a monthly response is a coarser
  // view of the same series, not a different endpoint.
  if (flags.pool) summary.avgPoolHashrateMhs = calculateAvgPoolHashrate(log)

  if (req.query.current && lPhases.hasMinerTelemetry(phase)) {
    summary.currentHashrateMhs = await getCurrentHashrate(ctx, hashrateAggrField(flags.container), flags.container)
  }

  return { log, totalCount: log.length, summary }
}

/**
 * The '1d' series, served month by month from cache: a year of local days is
 * otherwise rebuilt from ~8,760 hourly buckets (plus a year of pool samples
 * when `pool` is on) on every request. A month that has ended cannot gain
 * days, so its rows are reused and only the partial edge months and the
 * running month are recomputed; the TTL repays late-arriving samples the same
 * way the calendar-month rollup's cache does.
 */
async function getDailyHashrate (ctx, req, phase = null) {
  const { start, end } = validateStartEnd(req)
  const timezone = resolveTimezone(ctx, req)
  const now = Date.now()
  const flags = {
    nominal: req.query.nominal === true || req.query.nominal === 'true',
    siteNominal: req.query.siteNominal === true || req.query.siteNominal === 'true',
    pool: req.query.pool === true || req.query.pool === 'true',
    container: req.query.container || null,
    phase: phase?.id || null
  }

  const months = localMonthsInRange(start, end, timezone)
  // Only a month the request covers end to end holds whole days: a partial edge
  // month's first and last rows are clamped to the request, so it must neither be
  // stored nor answered from cache. The running month still gains days either way.
  const cacheable = (month) => month.end < now && month.start >= start && month.end <= end
  const refresh = !!req.query.overwriteCache
  const rows = new Map()
  const missing = []

  for (const month of months) {
    const cached = cacheable(month) && !refresh
      ? dailyHashesCache.get(dailyHashesCache.key(month.key, timezone, flags), now)
      : undefined

    if (cached !== undefined) rows.set(month.key, cached)
    else missing.push(month)
  }

  if (missing.length) {
    // One query over the span the misses cover, clamped to what was actually asked
    // for: the first and last month of a range are usually partial. `current` stays
    // out of the sub-request - it belongs to the response summary, computed below.
    const span = {
      start: Math.max(start, missing[0].start),
      end: Math.min(end, missing[missing.length - 1].end)
    }
    // A window ending exactly on a month boundary leaves a zero-width edge month
    // once the earlier months are answered from cache; validateStartEnd rejects
    // it, and stepping back one millisecond cannot add a bucket.
    if (span.end === span.start) span.start -= 1
    const { log } = await resolveHashrate(ctx, {
      ...req,
      query: { ...req.query, ...span, current: undefined }
    }, phase)

    // Grouped apart and then set wholesale: the span can cross a month that WAS
    // answered from cache (misses are not always contiguous), and appending into
    // that cached array would both duplicate its rows and corrupt the cache entry.
    const fresh = new Map()
    for (const entry of log) {
      const monthKey = localMonthKey(entry.ts, timezone)
      const monthRows = fresh.get(monthKey) ?? []
      monthRows.push(entry)
      fresh.set(monthKey, monthRows)
    }
    for (const [monthKey, monthRows] of fresh) rows.set(monthKey, monthRows)

    // A completed month with no reported days is cached as an empty list, not
    // skipped: leaving it out would keep it permanently missing and the query
    // span would stretch back over it on every request.
    for (const month of missing) {
      if (!cacheable(month)) continue

      const key = dailyHashesCache.key(month.key, timezone, flags)
      dailyHashesCache.set(key, rows.get(month.key) ?? [], now)
    }
  }

  const log = months.flatMap((month) => rows.get(month.key) ?? [])
  // A pool-only phase without a configured nominal omits the nominal fields
  // rather than reporting them as zero, exactly as resolvePoolOnlyHashrate does.
  const withNominal = flags.nominal && (lPhases.hasMinerTelemetry(phase) ||
    Number.isFinite(await resolvePhaseNominalHashrate(ctx, phase)))
  const summary = calculateHashrateSummary(log, withNominal)

  if (flags.pool) summary.avgPoolHashrateMhs = calculateAvgPoolHashrate(log)

  if (req.query.current && lPhases.hasMinerTelemetry(phase)) {
    summary.currentHashrateMhs = await getCurrentHashrate(ctx, hashrateAggrField(flags.container), flags.container)
  }

  return { log, summary }
}

async function resolveHashrate (ctx, req, phase = null) {
  const { start, end } = validateStartEnd(req)

  // A phase without MOS miners has no telemetry series: its hashrate IS the
  // pool-reported one, bucketed from its own accounts' samples.
  if (!lPhases.hasMinerTelemetry(phase)) return resolvePoolOnlyHashrate(ctx, req, phase)

  if (req.query.groupBy) return getGoupedHashrate(ctx, req)

  if (hasRackFilter(req)) {
    const { log } = await getGoupedHashrate(ctx, rackGroupedReq(req))
    const scoped = log.map(({ ts, timeRange, hashrateMhs }) => ({ ts, ...(timeRange && { timeRange }), hashrateMhs: sumObjectValues(hashrateMhs) }))
    return { log: scoped, summary: calculateHashrateSummary(scoped) }
  }

  const interval = resolveInterval(start, end, req.query.interval)
  if (isLocalInterval(interval)) return resolveLocalHashrate(ctx, req, { interval, start, end }, phase)

  const { key, groupRange } = getIntervalConfig(interval)
  const container = req.query.container || null
  const field = container ? LOG_FIELDS.HASHRATE_SUM_CONTAINER_GROUP : LOG_FIELDS.HASHRATE_SUM
  const aggrField = hashrateAggrField(container)
  // Invoicing needs delivered hashrate against the capacity installed at the time of each
  // bucket, which only the per-bucket aggregate carries. Opt-in: the site nominal alone is
  // served by /auth/site/status/live.
  const withNominal = req.query.nominal === true || req.query.nominal === 'true'
  // Invoicing bills against the configured site nominal instead of the installed capacity.
  const withSiteNominal = withNominal && (req.query.siteNominal === true || req.query.siteNominal === 'true')
  // Opt-in pool-reported hashrate per bucket, so invoicing can compare the
  // miner-telemetry series against what the pools credited.
  const withPool = req.query.pool === true || req.query.pool === 'true'

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
  const siteNominalMhs = withSiteNominal ? await getSiteNominalHashrate(ctx) : null

  const log = firstOrkEntries(res).map(val => {
    // The store labels a bucket with its start on the UTC grid, so in a zone off the whole
    // hour (e.g. +05:30) the first hour began before `start`: it only holds samples from
    // `start` on, but its ts sat in the previous local day and a '1d'/'1w' rollup opened
    // with an empty, inverted bucket. Clamped like consumption's, it lands inside the range.
    const ts = Math.max(start, parseEntryTs(val.ts))
    const rawRange = parseEntryTimeRange(val.ts)
    const timeRange = rawRange && { startTs: Math.max(start, rawRange.startTs), endTs: Math.min(end, rawRange.endTs) }
    const hashrateMhs = readHashrate(val[aggrField], container)
    if (!withNominal) {
      return {
        ts,
        ...(timeRange && { timeRange }),
        hashrateMhs
      }
    }

    const nominalHashrateMhs = siteNominalMhs ?? (Number(val[AGGR_FIELDS.NOMINAL_HASHRATE_SUM]) || 0)
    return {
      ts,
      ...(timeRange && { timeRange }),
      hashrateMhs,
      nominalHashrateMhs,
      pctOfNominal: nominalHashrateMhs ? (hashrateMhs / nominalHashrateMhs) * 100 : null
    }
  })

  if (withPool) {
    const accounts = phase ? lPhases.getPhaseAccountKeys(phase) : null
    await mergePoolHashrate(ctx, log, { start, end, groupRange, accounts })
  }

  const summary = calculateHashrateSummary(log, withNominal)

  if (withPool) summary.avgPoolHashrateMhs = calculateAvgPoolHashrate(log)

  if (req.query.current) {
    summary.currentHashrateMhs = await getCurrentHashrate(ctx, aggrField, container)
  }

  return { log, summary }
}

// Days and weeks are cut in the site's zone from hourly buckets: the store's own '1D'/'1W'
// sit on the UTC grid, so they started before `start` and spilled past `end` for any site
// not on UTC. Each bucket averages its hours, as the store averaged its samples.
async function resolveLocalHashrate (ctx, req, { interval, start, end }, phase = null) {
  const timezone = resolveTimezone(ctx, req)
  const withNominal = req.query.nominal === true || req.query.nominal === 'true'
  const withPool = req.query.pool === true || req.query.pool === 'true'

  const hourly = await resolveHashrate(ctx, { ...req, query: { ...req.query, interval: '1h' } }, phase)

  const log = groupLocalBuckets(hourly.log, { interval, timezone, start, end }).map(({ ts, timeRange, entries }) => {
    const hashrateMhs = meanOfField(entries, 'hashrateMhs')
    const entry = { ts, timeRange, hashrateMhs }

    if (withNominal) {
      entry.nominalHashrateMhs = meanOfField(entries, 'nominalHashrateMhs')
      entry.pctOfNominal = entry.nominalHashrateMhs ? (hashrateMhs / entry.nominalHashrateMhs) * 100 : null
    }
    // A bucket whose hours all lack a pool sample stays null, as an hourly one does.
    if (withPool) entry.poolHashrateMhs = meanOfField(entries, 'poolHashrateMhs')

    return entry
  })

  const summary = calculateHashrateSummary(log, withNominal)

  if (withPool) summary.avgPoolHashrateMhs = calculateAvgPoolHashrate(log)
  if (req.query.current) summary.currentHashrateMhs = hourly.summary.currentHashrateMhs

  return { log, summary }
}

async function getSiteNominalHashrate (ctx) {
  const res = await ctx.dataProxy.requestDataMap(RPC_METHODS.GLOBAL_CONFIG, {
    fields: { invoiceNominalHashrate_MHS: 1, nominalSiteHashrate_MHS: 1 }
  })
  const pick = (key) => res.map((config) => Number(config?.[key])).find((mhs) => mhs > 0) ?? null
  // Invoices bill against the contracted nominal where one is configured; it
  // deliberately does not touch nominalSiteHashrate_MHS, which the dashboards
  // read for their nominal lines.
  return pick('invoiceNominalHashrate_MHS') ?? pick('nominalSiteHashrate_MHS')
}

// Attaches the pool-reported hashrate to each miner-telemetry bucket, using the
// bucket's own time window so both series cover exactly the same period.
async function mergePoolHashrate (ctx, log, { start, end, groupRange, accounts = null }) {
  if (!log.length) return

  const bucketMs = RANGE_BUCKETS[groupRange] || (60 * 60 * 1_000) // '1H'
  const buckets = log.map((entry) => ({
    ts: entry.ts,
    startTs: entry.timeRange?.startTs ?? entry.ts,
    endTs: entry.timeRange?.endTs ?? entry.ts + bucketMs - 1
  }))

  const poolByBucket = await resolvePoolHashrateForBuckets(ctx, { start, end, buckets, accounts })

  for (const entry of log) {
    entry.poolHashrateMhs = poolByBucket.get(entry.ts) ?? null
  }
}

// Unlike the miner average, buckets without pool samples are excluded rather
// than counted as 0: a gap in pool polling must not read as lost hashrate.
function calculateAvgPoolHashrate (log) {
  const values = log.map((entry) => entry.poolHashrateMhs).filter(Number.isFinite)
  if (!values.length) return null
  return safeDiv(values.reduce((sum, val) => sum + val, 0), values.length)
}

/**
 * Hashrate series for a phase that has no MOS miners (`minerTelemetry: false`):
 * buckets are generated over the requested range and filled from the phase's
 * own pool accounts. Buckets the pool reported nothing for are absent rather
 * than zero-filled, matching the monthly rollup's behavior.
 */
async function resolvePoolOnlyHashrate (ctx, req, phase) {
  if (req.query.groupBy || hasRackFilter(req) || req.query.container) {
    throw lPhases.phaseError('ERR_PHASE_INVALID')
  }

  const { start, end } = validateStartEnd(req)
  const interval = resolveInterval(start, end, req.query.interval)
  const accounts = lPhases.getPhaseAccountKeys(phase)

  // Cut on the same grid as the phase's consumption and efficiency: whole hours inside
  // the range, and days/weeks in the site's zone clamped to [start, end]. The UTC grid
  // started the first bucket before `start` and ran the last one past `end`.
  const hours = []
  for (let ts = Math.ceil(start / HOUR_MS) * HOUR_MS; ts <= end; ts += HOUR_MS) {
    hours.push({ ts, timeRange: { startTs: ts, endTs: ts + HOUR_MS - 1 } })
  }
  const slots = isLocalInterval(interval)
    ? groupLocalBuckets(hours, { interval, timezone: resolveTimezone(ctx, req), start, end })
    : hours
  const buckets = slots.map(({ ts, timeRange }) => ({ ts, ...timeRange }))

  const poolByBucket = await resolvePoolHashrateForBuckets(ctx, { start, end, buckets, accounts })

  const withNominal = req.query.nominal === true || req.query.nominal === 'true'
  const withPool = req.query.pool === true || req.query.pool === 'true'
  const nominalHashrateMhs = withNominal ? await resolvePhaseNominalHashrate(ctx, phase) : null

  const log = []
  for (const bucket of buckets) {
    const hashrateMhs = poolByBucket.get(bucket.ts)
    if (!Number.isFinite(hashrateMhs)) continue

    const entry = {
      ts: bucket.ts,
      timeRange: { startTs: bucket.startTs, endTs: bucket.endTs },
      hashrateMhs
    }

    if (withNominal && Number.isFinite(nominalHashrateMhs)) {
      entry.nominalHashrateMhs = nominalHashrateMhs
      entry.pctOfNominal = nominalHashrateMhs ? (hashrateMhs / nominalHashrateMhs) * 100 : null
    }

    if (withPool) entry.poolHashrateMhs = hashrateMhs

    log.push(entry)
  }

  const summary = calculateHashrateSummary(log, withNominal && Number.isFinite(nominalHashrateMhs))
  if (withPool) summary.avgPoolHashrateMhs = calculateAvgPoolHashrate(log)

  return { log, summary }
}

async function resolvePhaseNominalHashrate (ctx, phase) {
  const results = await ctx.dataProxy.requestDataMap(RPC_METHODS.GLOBAL_CONFIG, {
    fields: { phaseNominals: 1 }
  })

  return lPhases.getPhaseNominals(results, phase.id)?.hashrateMhs ?? null
}

/**
 * Adds the configured synthetic group (e.g. the container's miner type) to the
 * grouped series for every pool-only phase, so the Miner Type / Mining Unit
 * views list the phase next to the telemetry-backed groups. Telemetry can
 * never produce these keys - the phase has no MOS miners - so there is
 * nothing to collide with.
 */
async function injectSyntheticHashrateGroups (ctx, req, log) {
  if (!log.length) return
  // `total` must list the phase groups exactly like a phase-less request -
  // the Total tab sends it. Only a concrete phase scopes them out.
  if (lPhases.resolvePhase(ctx, req)) return

  const groupBy = req.query.groupBy
  if (groupBy !== 'miner' && groupBy !== 'container') return

  const phases = lPhases.getPoolOnlyPhases(ctx)
  if (!phases.length) return

  const { start, end } = req.query
  const dayMs = 24 * 60 * 60 * 1_000
  const buckets = log.map((entry) => ({
    ts: entry.ts,
    startTs: entry.timeRange?.startTs ?? entry.ts,
    endTs: entry.timeRange?.endTs ?? entry.ts + dayMs - 1
  }))

  for (const phase of phases) {
    const key = groupBy === 'miner' ? phase.groups?.minerType : phase.groups?.container
    const accounts = lPhases.getPhaseAccountKeys(phase)
    if (!key || !accounts) continue

    const poolByBucket = await resolvePoolHashrateForBuckets(ctx, { start, end, buckets, accounts })

    for (const entry of log) {
      const hashrateMhs = poolByBucket.get(entry.ts)
      if (!Number.isFinite(hashrateMhs)) continue
      if (!entry.hashrateMhs || typeof entry.hashrateMhs !== 'object') entry.hashrateMhs = {}
      // A synthetic key colliding with a real device-type key is a config
      // error; losing telemetry to the overwrite would be worse than the
      // phase group going missing.
      if (entry.hashrateMhs[key] !== undefined) continue
      entry.hashrateMhs[key] = hashrateMhs
    }
  }
}

const HASHRATE_GROUP_FIELDS = {
  miner: { field: LOG_FIELDS.HASHRATE_SUM_TYPE_GROUP, aggrField: AGGR_FIELDS.HASHRATE_SUM_TYPE_GROUP_AGGR },
  container: { field: LOG_FIELDS.HASHRATE_SUM_CONTAINER_GROUP, aggrField: AGGR_FIELDS.HASHRATE_SUM_CONTAINER_GROUP_AGGR },
  rack: { field: LOG_FIELDS.HASHRATE_SUM_RACK_GROUP, aggrField: AGGR_FIELDS.HASHRATE_SUM_RACK_GROUP_AGGR }
}

async function getGoupedHashrate (ctx, req) {
  const { groupBy } = req.query
  const { start, end } = validateStartEnd(req)

  const { field, aggrField } = HASHRATE_GROUP_FIELDS[groupBy]

  // Days, weeks and months are cut in the site's zone from hourly buckets, as the
  // ungrouped series is: stat-1d sits on UTC midnights, so for a site off UTC its first
  // day fell before `start` and was dropped, and every row was a UTC day. A short range
  // ('1h') reads the hourly buckets themselves, again as the ungrouped series does:
  // stat-1d answered a one-day request with the UTC day's row, stamped after `start`
  // and without a timeRange, so no pool sample paired with it.
  const interval = resolveInterval(start, end, req.query.interval)
  const local = isLocalInterval(interval)

  const res = await ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, {
    type: WORKER_TYPES.MINER,
    tag: WORKER_TAGS.MINER,
    ...getIntervalConfig(local ? '1h' : interval),
    shouldCalculateAvg: true,
    start,
    end,
    fields: { [field]: 1 },
    aggrFields: { [aggrField]: 1 }
  })

  const rackFilter = groupBy === 'rack' ? rackFilterFor(parseRacks(req)) : null

  const entries = firstOrkEntries(res).map((val) => {
    let hashrateMhs = val[aggrField]
    if (rackFilter && hashrateMhs && typeof hashrateMhs === 'object') {
      hashrateMhs = Object.fromEntries(Object.entries(hashrateMhs).filter(([rack]) => rackFilter(rack)))
    }
    // An hour straddling `start` (zones off the whole hour) belongs to the range's first day.
    const ts = Math.max(start, parseEntryTs(val.ts))
    if (local) return { ts, hashrateMhs }
    const rawRange = parseEntryTimeRange(val.ts)
    const timeRange = rawRange && { startTs: Math.max(start, rawRange.startTs), endTs: Math.min(end, rawRange.endTs) }
    return { ts, ...(timeRange && { timeRange }), hashrateMhs }
  })

  const log = local
    ? rollupLocalGroupedHashrate(entries, { interval, timezone: resolveTimezone(ctx, req), start, end })
    : entries

  await injectSyntheticHashrateGroups(ctx, req, log)

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

// Each group averages the hours it reported in, as the store averaged its samples; an
// hour without a group map (no data) is skipped rather than counted as zero.
function rollupLocalGroupedHashrate (hourly, bucketing) {
  return groupLocalBuckets(hourly, bucketing).map(({ ts, timeRange, entries }) => {
    let counts = null
    let total = null
    for (const { hashrateMhs } of entries) {
      if (!hashrateMhs || typeof hashrateMhs !== 'object') continue
      counts = addBucketCounts(counts, hashrateMhs)
      total = addBucketValues(total, hashrateMhs)
    }
    return { ts, timeRange, hashrateMhs: total ? averageBucketValues(total, counts) : null }
  })
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

function addBucketValues (acc, val) {
  if (val && typeof val === 'object') {
    const out = { ...(acc || {}) }
    for (const [meter, v] of Object.entries(val)) out[meter] = (out[meter] || 0) + (Number(v) || 0)
    return out
  }
  return (acc || 0) + (Number(val) || 0)
}

const ROLLUP_INTERVALS = new Set(['1h', '1d', '1w', '1M'])

// The DCS worker persists hourly averages of the 5-minute power samples in its
// energy-1h rollup log (12 samples/h vs the 2 the stat-30m path sees). The
// rollup only exists from featureConfig.energyRollup.sinceTs onward (backfill
// included), so older ranges keep using the legacy stat-log path.
function canUseEnergyRollup (ctx, start, interval) {
  if (!isCentralDCSEnabled(ctx) || !ROLLUP_INTERVALS.has(interval)) return false
  const sinceTs = ctx.conf?.featureConfig?.energyRollup?.sinceTs
  return Number.isFinite(sinceTs) && start >= sinceTs
}

async function fetchEnergyRollupEntries (ctx, start, end) {
  const res = await ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, {
    type: WORKER_TYPES.DCS,
    tag: getDCSTag(ctx),
    key: LOG_KEYS.ENERGY_1H,
    start,
    end,
    // the worker only sizes reads automatically for stat-* keys; without an
    // explicit limit a ranged read of a non-stat log falls back to 100 entries
    limit: Math.ceil((end - start) / HOUR_MS) + 2,
    fields: { [LOG_FIELDS.SITE_POWER]: 1, [LOG_FIELDS.BY_METER_POWER]: 1 },
    aggrFields: { [AGGR_FIELDS.SITE_POWER]: 1, [AGGR_FIELDS.BY_METER_POWER]: 1 }
  })

  return firstOrkEntries(res)
    .map(entry => ({ ...entry, ts: parseEntryTs(entry.ts) }))
    .filter(entry => Number.isFinite(entry.ts))
    .sort((a, b) => a.ts - b.ts)
}

function rollupHourlyLog (entries, byMeter) {
  return entries.map(entry => {
    const timeRange = { startTs: entry.ts, endTs: entry.ts + HOUR_MS - 1 }

    if (byMeter) {
      const raw = entry[AGGR_FIELDS.BY_METER_POWER]
      const powerW = raw && typeof raw === 'object' ? raw : {}
      return {
        ts: entry.ts,
        timeRange,
        powerW,
        consumptionMWh: Object.fromEntries(
          Object.entries(powerW).map(([meter, w]) => [meter, (Number(w) || 0) / 1000000])
        )
      }
    }

    const powerW = Number(entry[AGGR_FIELDS.SITE_POWER]) || 0
    return { ts: entry.ts, timeRange, powerW, consumptionMWh: powerW / 1000000 }
  })
}

function addBucketCounts (acc, val) {
  if (val && typeof val === 'object') {
    const out = { ...(acc || {}) }
    for (const meter of Object.keys(val)) out[meter] = (out[meter] || 0) + 1
    return out
  }
  return (acc || 0) + 1
}

function averageBucketValues (total, counts) {
  if (total && typeof total === 'object') {
    return Object.fromEntries(
      Object.entries(total).map(([meter, v]) => [meter, safeDiv(v, counts?.[meter]) ?? 0])
    )
  }
  return safeDiv(Number(total) || 0, counts) ?? 0
}

// Days, weeks and months in the site's zone, built from hourly buckets: consumption is the
// exact sum of the hourly MWh, power the mean over the hours that reported. The store's own
// '1D'/'1W' sit on the UTC grid, so they started before `start` and spilled past `end`.
function rollupLocalConsumption (hourly, bucketing) {
  return groupLocalBuckets(hourly, bucketing).map(({ ts, timeRange, entries }) => {
    let counts = null
    let powerW = null
    let consumptionMWh = null
    for (const entry of entries) {
      counts = addBucketCounts(counts, entry.powerW)
      powerW = addBucketValues(powerW, entry.powerW)
      consumptionMWh = addBucketValues(consumptionMWh, entry.consumptionMWh)
    }
    return { ts, timeRange, powerW: averageBucketValues(powerW, counts), consumptionMWh }
  })
}

function buildRollupConsumption (entries, bucketing, byMeter) {
  const hourly = rollupHourlyLog(entries, byMeter)
  const log = isLocalInterval(bucketing.interval) ? rollupLocalConsumption(hourly, bucketing) : hourly

  const summary = byMeter
    ? calculateByMeterConsumptionSummary(log)
    : calculateConsumptionSummary(log)

  return { log, summary }
}

async function getConsumption (ctx, req) {
  const { start, end, timezone } = resolveStartEnd(ctx, req)
  const phase = lPhases.resolvePhase(ctx, req)

  // Downstream grouped/by-meter/rack paths read start/end straight off req.query,
  // so the converted UTC values have to replace the raw ones here for those to see them.
  req = { ...req, query: { ...req.query, start, end } }

  if (phase) {
    // A phase is a single series built from hourly meter and manual values;
    // there is no per-group, per-meter or per-rack split of it.
    const byMeter = req.query.byMeter === true || req.query.byMeter === 'true'
    if (req.query.groupBy || byMeter || hasRackFilter(req)) throw lPhases.phaseError('ERR_PHASE_NOT_SUPPORTED')
    const interval = resolveInterval(start, end, req.query.interval)
    return getPhaseConsumption(ctx, req, phase, { interval, timezone, start, end })
  }

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

  const interval = resolveInterval(start, end, req.query.interval)
  const bucketing = { interval, timezone, start, end }

  if (canUseEnergyRollup(ctx, start, interval)) {
    const entries = await fetchEnergyRollupEntries(ctx, start, end)
    if (entries.length) return buildRollupConsumption(entries, bucketing, false)
  }

  // Local days/weeks/months are rolled up from hourly buckets (see rollupLocalConsumption).
  const local = isLocalInterval(interval)
  const { key, groupRange } = getIntervalConfig(local ? '1h' : interval)

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
  const buckets = firstOrkEntries(res).map(val => {
    const powerW = Number(val[AGGR_FIELDS.SITE_POWER]) || 0
    const timeRange = parseEntryTimeRange(val.ts)
    return {
      ts: parseEntryTs(val.ts),
      ...(timeRange && { timeRange }),
      powerW,
      consumptionMWh: (powerW * hours) / 1000000
    }
  })

  const log = local ? rollupLocalConsumption(buckets, bucketing) : buckets
  const summary = calculateConsumptionSummary(log)

  return { log, summary }
}

const MANUAL_CONSUMPTION_FIELD = 'totalConsumptionMWh'

// Meter ids are matched loosely: config may say 'CCM' for the 'ccm' by-meter key.
const normalizeMeterKey = (id) => String(id).toLowerCase().replace(/[^a-z0-9]/g, '')

// Manual MWh per hour start from the DCS worker's consumption log. Hours whose
// value was never entered (or was cleared) are absent, not zero.
async function fetchManualConsumptionByHour (ctx, start, end) {
  const records = await getEnergyConsumption(ctx, { query: { start, end } })
  const byHour = new Map()
  for (const record of records) {
    const mwh = record[MANUAL_CONSUMPTION_FIELD]
    if (Number.isFinite(mwh)) byHour.set(record.ts, mwh)
  }
  return byHour
}

// Average W per hour start of one by_meter_power_w meter.
async function fetchMeterPowerByHour (ctx, req, meterKey) {
  const { log } = await getByMeterConsumption(ctx, { ...req, query: { ...req.query, interval: '1h' } })
  const wanted = normalizeMeterKey(meterKey)
  const byHour = new Map()
  for (const entry of log) {
    const match = Object.entries(entry.powerW || {}).find(([meter]) => normalizeMeterKey(meter) === wanted)
    if (match && Number.isFinite(Number(match[1]))) byHour.set(entry.ts, Number(match[1]))
  }
  return byHour
}

/**
 * Consumption of one phase, built hour by hour and then rolled up like the
 * site series. A `manual` phase is the hourly MWh logged on the DCS worker; a
 * `remainder` phase is its meter minus those manual entries, since the
 * manually logged load is fed through that meter. A `remainder` hour with no
 * manual entry reads that entry as 0 (the meter is still the phase's own load
 * then) and is counted in summary.manualMissingHours, so the fallback stays
 * visible. Any other elapsed hour missing an input - no meter value, or no
 * entry for a `manual` phase - is left out of the series and counted in
 * summary.missingHours rather than read as zero.
 *
 * The hourly rows are served month by month from a cache: revenue-summary and
 * the efficiency views rebuild this series over their whole window on every
 * request, which would price each call at a full meter scan plus the manual
 * log. A month that has ended holds only elapsed hours, so its rows are
 * complete; manual entries arriving later drop the cache from the write path
 * (energy.handlers), and store-side backfills are repaid by the TTL.
 */
async function getPhaseConsumption (ctx, req, phase, bucketing) {
  const { isRemainder, rows, missingHours } = await getPhaseHourly(ctx, req, phase, bucketing)

  let manualMissingHours = 0
  const hourly = rows.map(({ manualMissing, ...entry }) => {
    if (manualMissing) manualMissingHours++
    return entry
  })

  const log = isLocalInterval(bucketing.interval) ? rollupLocalConsumption(hourly, bucketing) : hourly
  const summary = { ...calculateConsumptionSummary(log), missingHours }
  if (isRemainder) summary.manualMissingHours = manualMissingHours
  return { log, summary }
}

// The phase's hourly rows over the elapsed hours of [start, end], still carrying
// the manualMissing flag, and the count of hours left out for a missing input.
async function getPhaseHourly (ctx, req, phase, { start, end }) {
  const { source, meterKey } = lPhases.getPhaseConsumptionSource(phase)
  if (!isCentralDCSEnabled(ctx)) throw new Error('ERR_PHASE_CONSUMPTION_REQUIRES_CENTRAL_DCS')

  const byHour = await resolvePhaseHourlyRows(ctx, req, phase, { source, meterKey }, start, end)

  const rows = []
  let missingHours = 0
  for (const ts of lPhases.elapsedHourStarts(start, end)) {
    const row = byHour.get(ts)
    if (row) rows.push(row)
    else missingHours++
  }
  return { isRemainder: source === lPhases.CONSUMPTION_SOURCES.REMAINDER, rows, missingHours }
}

// One span of the phase's hourly rows, straight from the sources: the hours of
// [start, end] that have elapsed and carry every input they need (see
// getPhaseConsumption). Hours missing an input are simply absent, except a
// remainder hour without a manual entry: it subtracts 0 and is flagged
// manualMissing (kept in the cached row, stripped from the served log).
async function fetchPhaseHourlyRows (ctx, req, { source, meterKey }, start, end) {
  const spanReq = { ...req, query: { ...req.query, start, end } }
  const [manualByHour, meterByHour] = await Promise.all([
    fetchManualConsumptionByHour(ctx, start, end),
    source === lPhases.CONSUMPTION_SOURCES.REMAINDER ? fetchMeterPowerByHour(ctx, spanReq, meterKey) : null
  ])

  const rows = []
  for (const ts of lPhases.elapsedHourStarts(start, end)) {
    const manualMWh = manualByHour.get(ts)
    if (meterByHour) {
      const meterW = meterByHour.get(ts)
      if (meterW === undefined) continue
      const manualMissing = manualMWh === undefined
      const consumptionMWh = meterW / 1000000 - (manualMissing ? 0 : manualMWh)
      rows.push({
        ts,
        timeRange: { startTs: ts, endTs: ts + HOUR_MS - 1 },
        powerW: consumptionMWh * 1000000,
        consumptionMWh,
        ...(manualMissing && { manualMissing })
      })
      continue
    }
    if (manualMWh === undefined) continue
    rows.push({
      ts,
      timeRange: { startTs: ts, endTs: ts + HOUR_MS - 1 },
      powerW: manualMWh * 1000000,
      consumptionMWh: manualMWh
    })
  }
  return rows
}

// Months in list order split into runs of adjacent months, so a cold year is
// fetched as one span instead of twelve.
function contiguousMonthRuns (items) {
  const runs = []
  for (const item of items) {
    const run = runs[runs.length - 1]
    if (run && run[run.length - 1].month.end + 1 === item.month.start) run.push(item)
    else runs.push([item])
  }
  return runs
}

/**
 * The phase's hourly rows over [start, end], keyed by hour start - cached month
 * by month. Months are cut on UTC purely to partition the cache: hourly rows
 * slice cleanly at any whole hour, so the request's own zone never matters here
 * and a partially covered cached month can still be answered (extra hours are
 * ignored by the caller's elapsed-hours walk). Only a fully covered, ended
 * month is fetched as a cacheable whole; the edges and the running month are
 * fetched per request. Concurrent requests share one fetch per month: the
 * Project Financials tab fires three revenue summaries at once, and each used
 * to rebuild the same year three times over.
 */
async function resolvePhaseHourlyRows (ctx, req, phase, sourceCfg, start, end) {
  const inflight = (ctx._phaseHourlyInflight ??= new Map())
  const now = Date.now()
  const refresh = !!req.query.overwriteCache
  const byHour = new Map()
  const addRows = (rows) => { for (const row of rows) byHour.set(row.ts, row) }
  const waits = []
  const toFetch = []

  for (const month of localMonthsInRange(start, end, 'UTC')) {
    const ended = month.end < now
    const key = phaseHourlyCacheKey(month.key, phase.id, sourceCfg.source, sourceCfg.meterKey)

    const cached = ended && !refresh ? phaseHourlyCache.get(key, now) : undefined
    if (cached !== undefined) {
      addRows(cached)
      continue
    }

    if (ended && month.start >= start && month.end <= end) {
      // An in-flight fetch from before a manual write may predate it; a request
      // arriving after the write must read fresh instead of riding it.
      const pending = inflight.get(key)
      if (pending && pending.generation === phaseHourlyGeneration()) waits.push(pending.promise.then(addRows))
      else toFetch.push({ month, key })
      continue
    }

    // A partial edge month or the running month: its slice is this request's
    // own, so it is neither shared nor stored. A window ending exactly on a
    // month boundary leaves a zero-width edge month the sources would reject;
    // stepping back one millisecond cannot add an hour bucket, so the rows are
    // the ones the single-pass fetch always returned for that instant.
    const span = { start: Math.max(start, month.start), end: Math.min(end, month.end) }
    if (span.end === span.start) span.start -= 1
    waits.push(fetchPhaseHourlyRows(ctx, req, sourceCfg, span.start, span.end).then(addRows))
  }

  // Each run of adjacent misses is one query over their whole span, but every
  // month is published and stored on its own, so concurrent windows that only
  // overlap part of the run still share it.
  for (const run of contiguousMonthRuns(toFetch)) {
    // A clear while this fetch is in flight means a write landed that these rows
    // may predate: they still answer this request, but must not be re-stored
    // over the invalidation.
    const generation = phaseHourlyGeneration()
    const fetched = fetchPhaseHourlyRows(ctx, req, sourceCfg, run[0].month.start, run[run.length - 1].month.end)

    for (const { month, key } of run) {
      const promise = fetched
        .then((rows) => {
          const monthRows = rows.filter((row) => row.ts >= month.start && row.ts <= month.end)
          if (phaseHourlyGeneration() === generation) phaseHourlyCache.set(key, monthRows, now)
          return monthRows
        })
      const entry = { generation, promise }
      // A post-write fetch may have replaced a stale entry; only this one is retired.
      promise.finally(() => { if (inflight.get(key) === entry) inflight.delete(key) }).catch(() => {})
      inflight.set(key, entry)
      waits.push(promise.then(addRows))
    }
  }

  await Promise.all(waits)
  return byHour
}

// by_meter_power_w is only produced by the DCS worker, so the per-meter breakdown
// is only meaningful when Central-DCS is enabled.
async function getByMeterConsumption (ctx, req) {
  const { start, end, timezone } = resolveStartEnd(ctx, req)

  if (!isCentralDCSEnabled(ctx)) {
    throw new Error('ERR_BY_METER_REQUIRES_CENTRAL_DCS')
  }

  const interval = resolveInterval(start, end, req.query.interval)
  const bucketing = { interval, timezone, start, end }

  if (canUseEnergyRollup(ctx, start, interval)) {
    const entries = await fetchEnergyRollupEntries(ctx, start, end)
    if (entries.length) return buildRollupConsumption(entries, bucketing, true)
  }

  const { key, groupRange } = getIntervalConfig(isLocalInterval(interval) ? '1h' : interval)

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

  return buildByMeterConsumption(firstOrkEntries(res), AGGR_FIELDS.BY_METER_POWER, hours, bucketing)
}

// by_meter_power_w arrives as a { meter: powerW } map per bucket. Mirror the
// grouped-consumption shape so each entry carries per-meter power/consumption.
function buildByMeterConsumption (entries, aggrField, hours, bucketing) {
  const buckets = entries.map(val => {
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

  const log = isLocalInterval(bucketing?.interval) ? rollupLocalConsumption(buckets, bucketing) : buckets
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

/**
 * Adds the configured synthetic group (e.g. the container's miner type) of every
 * manually measured phase to the grouped consumption, so the Miner Type / Mining
 * Unit views list the phase next to the telemetry-backed groups, as the grouped
 * hashrate does. Its power is the mean of the hours logged in each day; a day
 * without any logged hour gets no key rather than a zero. The grouped series is
 * miner telemetry only, so the phase's load is not counted twice.
 */
// The local days (in `timezone`) the rows of a stat-1D log fall on, from the
// first row's day through the end of the last row's, as an inclusive [start, end].
// Both synthetic group injections read their phase data over this window, so a
// row's consumption and its efficiency cover the same hours.
function localDayWindow (log, timezone) {
  const tss = log.map((entry) => entry.ts)
  return {
    start: localDayStart(Math.min(...tss), timezone),
    end: nextLocalDayStart(Math.max(...tss), timezone) - 1
  }
}

async function injectSyntheticConsumptionGroups (ctx, req, log) {
  if (!log.length) return
  // `total` must list the phase groups exactly like a phase-less request.
  if (lPhases.resolvePhase(ctx, req)) return

  const groupBy = req.query.groupBy
  if (groupBy !== 'miner' && groupBy !== 'container') return
  if (!isCentralDCSEnabled(ctx)) return

  const keys = (lPhases.getPhases(ctx) || [])
    .filter((p) => p?.consumption?.source === lPhases.CONSUMPTION_SOURCES.MANUAL)
    .map((p) => (groupBy === 'miner' ? p.groups?.minerType : p.groups?.container))
    .filter(Boolean)
  if (!keys.length) return

  // A stat-1D row is a snapshot stamped at UTC midnight, which the site's zone
  // places on its own local day (00:00Z is 20:00 the day before in UTC-4), and
  // manual hours are logged on that local grid. Each row takes the manual hours
  // of its local day: a UTC window from the row's ts would miss the hours of a
  // local-day request, whose start lies after the UTC midnight row it never reads.
  const timezone = resolveTimezone(ctx, req)
  const dayOf = (ts) => localDayStart(ts, timezone)
  const { start, end } = localDayWindow(log, timezone)
  const manualByHour = await fetchManualConsumptionByHour(ctx, start, end)

  const manualByDay = new Map()
  for (const [ts, mwh] of manualByHour) {
    const day = dayOf(ts)
    const acc = manualByDay.get(day) || { totalMWh: 0, hours: 0 }
    acc.totalMWh += mwh
    acc.hours++
    manualByDay.set(day, acc)
  }

  for (const entry of log) {
    const { totalMWh, hours } = manualByDay.get(dayOf(entry.ts)) || { totalMWh: 0, hours: 0 }
    if (!hours) continue

    const powerW = (totalMWh / hours) * 1000000
    // Copies: the maps can be shared with the worker response (or between rows)
    entry.powerW = entry.powerW && typeof entry.powerW === 'object' ? { ...entry.powerW } : {}
    entry.consumptionMWh = entry.consumptionMWh && typeof entry.consumptionMWh === 'object'
      ? { ...entry.consumptionMWh }
      : {}
    for (const key of keys) {
      // A synthetic key colliding with a real device-type key is a config error;
      // losing telemetry to the overwrite would be worse than the group going missing.
      if (entry.powerW[key] !== undefined) continue
      entry.powerW[key] = powerW
      // The energy actually logged, not the mean stretched over 24 h: a day with only
      // some hours entered would otherwise report hours that were never logged.
      entry.consumptionMWh[key] = totalMWh
    }
  }
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

  await injectSyntheticConsumptionGroups(ctx, req, log)

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
  // MWh a row carries itself where it differs from its power over 24 h (a manual
  // phase group with only some hours logged): the gap is added to the 24 h total.
  const groupMWhAdjust = {}

  for (const entry of log) {
    const powerW = entry.powerW
    if (typeof powerW === 'object' && powerW !== null) {
      for (const [name, val] of Object.entries(powerW)) {
        const v = Number(val) || 0
        groupTotals[name] = (groupTotals[name] || 0) + v
        groupCounts[name] = (groupCounts[name] || 0) + 1
        const mwh = entry.consumptionMWh?.[name]
        const fullDayMWh = (v * 24) / 1000000
        if (Number.isFinite(mwh) && mwh !== fullDayMWh) {
          groupMWhAdjust[name] = (groupMWhAdjust[name] || 0) + mwh - fullDayMWh
        }
      }
    }
  }

  const byGroup = {}
  let siteTotal = 0
  let siteMWhAdjust = 0
  for (const [name, total] of Object.entries(groupTotals)) {
    const avgPowerW = safeDiv(total, groupCounts[name])
    const adjust = groupMWhAdjust[name] || 0
    byGroup[name] = {
      avgPowerW,
      totalConsumptionMWh: (total * 24) / 1000000 + adjust
    }
    siteTotal += total
    siteMWhAdjust += adjust
  }

  return {
    avgPowerW: safeDiv(siteTotal, log.length),
    totalConsumptionMWh: (siteTotal * 24) / 1000000 + siteMWhAdjust,
    groupedBy: byGroup
  }
}

async function getEfficiency (ctx, req) {
  const { start, end, timezone } = resolveStartEnd(ctx, req)
  const phase = lPhases.resolvePhase(ctx, req)
  // Downstream grouped/rack paths read start/end straight off req.query, so the
  // converted UTC values have to replace the raw ones here for those to see them.
  req = { ...req, query: { ...req.query, start, end } }

  if (!lPhases.hasMinerTelemetry(phase)) {
    if (req.query.groupBy || hasRackFilter(req)) throw lPhases.phaseError('ERR_PHASE_INVALID')
    const interval = resolveInterval(start, end, req.query.interval)
    return getPoolOnlyEfficiency(ctx, req, phase, { interval, timezone, start, end })
  }

  if (req.query.groupBy) return getGroupedEfficiency(ctx, req)

  if (hasRackFilter(req)) {
    const { log } = await getGroupedEfficiency(ctx, rackGroupedReq(req))
    const scoped = log.map(({ ts, efficiencyWThs }) => ({ ts, efficiencyWThs: avgObjectValues(efficiencyWThs) }))
    return { log: scoped, summary: calculateEfficiencySummary(scoped) }
  }

  const interval = resolveInterval(start, end, req.query.interval)
  const bucketing = { interval, timezone, start, end }

  // A telemetry phase's power is its own consumption series, not the site meter.
  if (phase) return getTelemetryPhaseEfficiency(ctx, req, phase, bucketing)

  // Local days/weeks/months are rolled up from hourly buckets: the store's own '1D'/'1W'
  // sit on the UTC grid, so they started before `start` and spilled past `end`.
  const local = isLocalInterval(interval)
  const { key, groupRange } = getIntervalConfig(local ? '1h' : interval)

  // Central-DCS sites have no miner-reported site efficiency stat; derive it from
  // the DCS site meter (site_power_w) over miner hashrate
  if (isCentralDCSEnabled(ctx)) {
    return getDCSEfficiency(ctx, { key, groupRange, start, end, bucketing: local ? bucketing : null })
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

  const buckets = firstOrkEntries(res).map(val => {
    const timeRange = parseEntryTimeRange(val.ts)
    return {
      ts: parseEntryTs(val.ts),
      ...(timeRange && { timeRange }),
      efficiencyWThs: Number(val[AGGR_FIELDS.EFFICIENCY]) || 0
    }
  })

  const log = local
    ? groupLocalBuckets(buckets, bucketing).map(({ ts, timeRange, entries }) => ({
      ts,
      timeRange,
      efficiencyWThs: meanOfField(entries, 'efficiencyWThs')
    }))
    : buckets
  const summary = calculateEfficiencySummary(log)

  return { log, summary }
}

// Site-meter efficiency (W/THs) per interval bucket: DCS site_power_w over total
// miner hashrate for the same bucket. Both series share the interval/groupRange
// so their timestamps align; we key hashrate by ts and divide per DCS power point.
// With `bucketing`, the hourly power and hashrate are each averaged over the local
// bucket first, so a bucket's efficiency is its mean power over its mean hashrate.
async function getDCSEfficiency (ctx, { key, groupRange, start, end, bucketing }) {
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

  const points = firstOrkEntries(powerRes).map(val => {
    const timeRange = parseEntryTimeRange(val.ts)
    return {
      ts: parseEntryTs(val.ts),
      ...(timeRange && { timeRange }),
      powerW: Number(val[AGGR_FIELDS.SITE_POWER]) || 0,
      hashrateMhs: hashrateByTs.get(val.ts) || 0
    }
  })

  // The site meter also feeds the pool-only phases (no miner telemetry), so
  // their pool hashrate joins the miners' in the divisor. Points are hourly
  // here (local intervals are rolled up below).
  const poolOnlyAccounts = lPhases.getPoolOnlyAccountKeys(ctx)
  if (poolOnlyAccounts.size && points.length) {
    const buckets = points.map(({ ts, timeRange }) => ({
      ts,
      startTs: timeRange?.startTs ?? ts,
      endTs: timeRange?.endTs ?? ts + HOUR_MS - 1
    }))
    const poolByBucket = await resolvePoolHashrateForBuckets(ctx, { start, end, buckets, accounts: poolOnlyAccounts })
    for (const point of points) point.hashrateMhs += poolByBucket.get(point.ts) || 0
  }

  const buckets = bucketing
    ? groupLocalBuckets(points, bucketing).map(({ ts, timeRange, entries }) => ({
      ts,
      timeRange,
      powerW: meanOfField(entries, 'powerW'),
      hashrateMhs: meanOfField(entries, 'hashrateMhs')
    }))
    : points

  const log = buckets.map(({ powerW, hashrateMhs, ...bucket }) => {
    const hashrateThs = mhsToThs(hashrateMhs)
    return { ...bucket, efficiencyWThs: hashrateThs > 0 ? powerW / hashrateThs : 0 }
  })

  const summary = calculateEfficiencySummary(log)

  return { log, summary }
}

/**
 * Efficiency for a phase without MOS miners: its own consumption series (see
 * getPhaseConsumption) over its own pool hashrate, bucket by bucket.
 */
async function getPoolOnlyEfficiency (ctx, req, phase, bucketing) {
  const { start, end } = bucketing
  const consumption = await getPhaseConsumption(ctx, req, phase, bucketing)
  const { missingHours, manualMissingHours } = consumption.summary
  const gaps = { missingHours, ...(manualMissingHours !== undefined && { manualMissingHours }) }
  if (!consumption.log.length) {
    return { log: [], summary: { ...calculateEfficiencySummary([]), ...gaps } }
  }

  const buckets = consumption.log.map(({ ts, timeRange }) => ({ ts, ...timeRange }))
  const accounts = lPhases.getPhaseAccountKeys(phase)
  const poolByBucket = await resolvePoolHashrateForBuckets(ctx, { start, end, buckets, accounts })

  const log = consumption.log.map(({ ts, timeRange, powerW }) => {
    const hashrateThs = mhsToThs(poolByBucket.get(ts) || 0)
    return { ts, timeRange, efficiencyWThs: hashrateThs > 0 ? powerW / hashrateThs : 0 }
  })

  return { log, summary: { ...calculateEfficiencySummary(log), ...gaps } }
}

/**
 * Efficiency for a phase whose miners report to MOS: its consumption series
 * (for a remainder phase, its meter minus the manual entries) over the fleet's
 * miner hashrate, joined hour by hour and then averaged per bucket like the
 * site series. An hour without a hashrate sample is counted in missingHours
 * along with the hours the consumption series already left out. For a
 * remainder phase, the kept hours whose power is the full meter (no manual
 * entry) are counted in manualMissingHours, as in the consumption summary.
 */
async function getTelemetryPhaseEfficiency (ctx, req, phase, bucketing) {
  const { start, end, interval } = bucketing
  const { key, groupRange } = getIntervalConfig('1h')

  const [consumption, hashrateRes] = await Promise.all([
    getPhaseHourly(ctx, req, phase, bucketing),
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

  const hashrateByHour = new Map()
  for (const val of firstOrkEntries(hashrateRes)) {
    const hashrateMhs = Number(val[AGGR_FIELDS.HASHRATE_SUM])
    if (Number.isFinite(hashrateMhs)) hashrateByHour.set(parseEntryTs(val.ts), hashrateMhs)
  }

  let missingHours = consumption.missingHours
  let manualMissingHours = 0
  const points = []
  for (const { ts, timeRange, powerW, manualMissing } of consumption.rows) {
    const hashrateMhs = hashrateByHour.get(ts)
    if (hashrateMhs === undefined) {
      missingHours++
      continue
    }
    if (manualMissing) manualMissingHours++
    points.push({ ts, timeRange, powerW, hashrateMhs })
  }

  const buckets = isLocalInterval(interval)
    ? groupLocalBuckets(points, bucketing).map(({ ts, timeRange, entries }) => ({
      ts,
      timeRange,
      powerW: meanOfField(entries, 'powerW'),
      hashrateMhs: meanOfField(entries, 'hashrateMhs')
    }))
    : points

  const log = buckets.map(({ powerW, hashrateMhs, ...bucket }) => {
    const hashrateThs = mhsToThs(hashrateMhs)
    return { ...bucket, efficiencyWThs: hashrateThs > 0 ? powerW / hashrateThs : 0 }
  })

  const summary = { ...calculateEfficiencySummary(log), missingHours }
  if (consumption.isRemainder) summary.manualMissingHours = manualMissingHours
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

  await injectSyntheticEfficiencyGroups(ctx, req, log)

  const summary = calculateGroupedEfficiencySummary(log, groupBy)

  return { log, summary }
}

/**
 * Adds the configured synthetic group (e.g. the container's miner type) of every
 * pool-only phase to the grouped efficiency, so the Miner Type / Mining Unit
 * views list the phase next to the miner-reported groups. Its value is the
 * phase's own daily efficiency (its consumption over its pool hashrate, see
 * getPoolOnlyEfficiency), taken per local day like the grouped consumption: a
 * stat-1D row stamped at UTC midnight reads the site-local day it falls on. A
 * day without consumption or pool hashrate gets no key rather than a zero.
 */
async function injectSyntheticEfficiencyGroups (ctx, req, log) {
  if (!log.length) return
  // `total` must list the phase groups exactly like a phase-less request.
  if (lPhases.resolvePhase(ctx, req)) return

  const groupBy = req.query.groupBy
  if (groupBy !== 'miner' && groupBy !== 'container') return
  // The phase consumption series exists only on central-DCS sites.
  if (!isCentralDCSEnabled(ctx)) return

  const phases = lPhases.getPoolOnlyPhases(ctx)
    .map((phase) => ({ phase, key: groupBy === 'miner' ? phase.groups?.minerType : phase.groups?.container }))
    .filter(({ phase, key }) => key && hasConsumptionSource(phase))
  if (!phases.length) return

  const timezone = resolveTimezone(ctx, req)
  const dayOf = (ts) => localDayStart(ts, timezone)
  const bucketing = { interval: '1d', timezone, ...localDayWindow(log, timezone) }
  const phaseReq = { ...req, query: { ...req.query, start: bucketing.start, end: bucketing.end } }

  const results = await Promise.all(phases.map(({ phase }) => getPoolOnlyEfficiency(ctx, phaseReq, phase, bucketing)))

  for (const [i, { key }] of phases.entries()) {
    const byDay = new Map()
    for (const { ts, efficiencyWThs } of results[i].log) {
      if (Number.isFinite(efficiencyWThs) && efficiencyWThs > 0) byDay.set(dayOf(ts), efficiencyWThs)
    }

    for (const entry of log) {
      const efficiencyWThs = byDay.get(dayOf(entry.ts))
      if (efficiencyWThs === undefined) continue
      // Copy: the map can be shared with the worker response
      entry.efficiencyWThs = entry.efficiencyWThs && typeof entry.efficiencyWThs === 'object'
        ? { ...entry.efficiencyWThs }
        : {}
      // A synthetic key colliding with a real device-type key is a config error;
      // losing telemetry to the overwrite would be worse than the group going missing.
      if (entry.efficiencyWThs[key] !== undefined) continue
      entry.efficiencyWThs[key] = efficiencyWThs
    }
  }
}

function hasConsumptionSource (phase) {
  try {
    lPhases.getPhaseConsumptionSource(phase)
    return true
  } catch {
    return false
  }
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
  const { start, end, timezone } = resolveStartEnd(ctx, req)
  // getGroupedMinerStatus reads start/end straight off req.query, so the converted
  // UTC values have to replace the raw ones here for it to see them.
  req = { ...req, query: { ...req.query, start, end } }
  // Days are the site's local calendar days, clamped to the requested range.
  const bucketing = { interval: '1d', timezone, start, end }

  if (req.query.groupBy) return getGroupedMinerStatus(ctx, req, bucketing)

  const results = await ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, {
    key: LOG_KEYS.STAT_3H,
    type: WORKER_TYPES.MINER,
    tag: WORKER_TAGS.MINER,
    aggrFields: {
      [AGGR_FIELDS.TYPE_CNT]: 1,
      [AGGR_FIELDS.MINING_CNT]: 1,
      [AGGR_FIELDS.OFFLINE_CNT]: 1,
      [AGGR_FIELDS.SLEEP_CNT]: 1,
      [AGGR_FIELDS.MAINTENANCE_CNT]: 1,
      [AGGR_FIELDS.ERROR_CNT]: 1
    },
    start,
    end
  })

  const log = processMinerStatusData(results, bucketing)
  const summary = calculateMinerStatusSummary(log)

  return { log, summary }
}

// Averages the day's stat snapshots app-side instead of via groupRange on the
// worker: the worker-side average skips snapshots where a grouped-count key is
// absent, so a status seen in a single snapshot was reported at its full count
// for the whole day. Days are local to `bucketing.timezone` and clamped to
// [bucketing.start, bucketing.end] - see groupLocalBuckets.
function processMinerStatusData (results, bucketing) {
  const snapshots = []
  for (const entry of iterateRpcEntries(results)) {
    const ts = parseEntryTs(entry.ts || entry.timestamp)
    if (ts) snapshots.push({ ts, entry })
  }

  return groupLocalBuckets(snapshots, bucketing).map(({ ts, timeRange, entries }) => {
    const bucket = { total: 0, mining: null, offline: 0, sleep: 0, maintenance: 0, error: 0, snapshots: new Set() }
    for (const { ts: rawTs, entry } of entries) {
      bucket.snapshots.add(rawTs)
      bucket.offline += sumObjectValues(entry[AGGR_FIELDS.OFFLINE_CNT] || entry.aggrFields?.[AGGR_FIELDS.OFFLINE_CNT])
      bucket.sleep += sumObjectValues(entry[AGGR_FIELDS.SLEEP_CNT] || entry.aggrFields?.[AGGR_FIELDS.SLEEP_CNT])
      bucket.maintenance += sumObjectValues(entry[AGGR_FIELDS.MAINTENANCE_CNT] || entry.aggrFields?.[AGGR_FIELDS.MAINTENANCE_CNT])
      bucket.error += sumObjectValues(entry[AGGR_FIELDS.ERROR_CNT] || entry.aggrFields?.[AGGR_FIELDS.ERROR_CNT])
      bucket.total += sumObjectValues(entry[AGGR_FIELDS.TYPE_CNT]) || entry.total_cnt || entry.count || 0

      const mining = entry[AGGR_FIELDS.MINING_CNT] ?? entry.aggrFields?.[AGGR_FIELDS.MINING_CNT]
      if (typeof mining === 'number') bucket.mining = (bucket.mining || 0) + mining
    }

    const count = bucket.snapshots.size || 1
    const offline = Math.round(bucket.offline / count)
    const sleep = Math.round(bucket.sleep / count)
    const maintenance = Math.round(bucket.maintenance / count)
    const error = Math.round(bucket.error / count)
    const total = Math.round(bucket.total / count)
    // Online is the actual mining count (same field the live site header uses;
    // excludes the maintenance container), so the chart agrees with the header
    // regardless of whether the worker's type_cnt includes maintenance miners.
    // Workers without the field fall back to the derived value: their type_cnt
    // still counts maintenance miners, so maintenance is subtracted back out.
    const online = bucket.mining !== null
      ? Math.round(bucket.mining / count)
      : Math.max(0, total - offline - sleep - maintenance - error)
    return { ts, online, offline, sleep, maintenance, error, timeRange }
  })
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

async function getGroupedMinerStatus (ctx, req, bucketing) {
  const { start, end } = req.query

  const aggrFields = {}
  for (const field of Object.values(MINER_STATUS_TYPE_FIELDS)) aggrFields[field] = 1

  const results = await ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, {
    key: LOG_KEYS.STAT_3H,
    type: WORKER_TYPES.MINER,
    tag: WORKER_TAGS.MINER,
    aggrFields,
    start,
    end
  })

  return { log: processGroupedMinerStatusData(results, bucketing) }
}

// Same local-day bucket averaging as processMinerStatusData, per miner type.
function processGroupedMinerStatusData (results, bucketing) {
  const snapshots = []
  for (const entry of iterateRpcEntries(results)) {
    const ts = parseEntryTs(entry.ts || entry.timestamp)
    if (ts) snapshots.push({ ts, entry })
  }

  return groupLocalBuckets(snapshots, bucketing).map(({ ts, timeRange, entries }) => {
    const bucket = { total: {}, online: {}, offline: {}, sleep: {}, maintenance: {}, error: {} }
    const seen = new Set()
    for (const { ts: rawTs, entry } of entries) {
      seen.add(rawTs)
      mergeGroupedField(bucket.total, entry[AGGR_FIELDS.TYPE_CNT])
      mergeGroupedField(bucket.offline, entry[AGGR_FIELDS.OFFLINE_TYPE_CNT])
      mergeGroupedField(bucket.sleep, entry[AGGR_FIELDS.SLEEP_TYPE_CNT])
      mergeGroupedField(bucket.maintenance, entry[AGGR_FIELDS.MAINTENANCE_CNT])
      mergeGroupedField(bucket.error, entry[AGGR_FIELDS.ERROR_TYPE_CNT])
    }

    const count = seen.size || 1
    for (const field of ['total', 'offline', 'sleep', 'maintenance', 'error']) {
      for (const key of Object.keys(bucket[field])) {
        bucket[field][key] = Math.round(bucket[field][key] / count)
      }
    }
    // type_cnt does not count miners parked in the maintenance container, so
    // maintenance must not be subtracted here — it is a separate bucket, not a
    // slice of the total.
    for (const type of Object.keys(bucket.total)) {
      const online = bucket.total[type] - (bucket.offline[type] || 0) - (bucket.sleep[type] || 0) - (bucket.error[type] || 0)
      bucket.online[type] = Math.max(0, online)
    }
    return { ts, ...bucket, timeRange }
  })
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

const CONTAINER_MINER_COUNT_AGGR_FIELDS = {
  [AGGR_FIELDS.OFFLINE_CNT]: 1,
  [AGGR_FIELDS.ERROR_CNT]: 1,
  [AGGR_FIELDS.NOT_MINING_CNT]: 1,
  [AGGR_FIELDS.SLEEP_CNT]: 1,
  [AGGR_FIELDS.POWER_MODE_LOW_CNT]: 1,
  [AGGR_FIELDS.POWER_MODE_NORMAL_CNT]: 1,
  [AGGR_FIELDS.POWER_MODE_HIGH_CNT]: 1
}

async function getMinerCountsByContainer (ctx) {
  const results = await ctx.dataProxy.requestDataMap(RPC_METHODS.TAIL_LOG_MULTI, {
    keys: [{ key: LOG_KEYS.STAT_RTD, type: WORKER_TYPES.MINER, tag: WORKER_TAGS.MINER }],
    limit: 1,
    aggrFields: CONTAINER_MINER_COUNT_AGGR_FIELDS
  })

  const counts = {}
  for (const orkResult of results) {
    const entry = extractKeyEntry(orkResult, 0)
    if (!entry) continue
    for (const field of Object.keys(CONTAINER_MINER_COUNT_AGGR_FIELDS)) {
      mergeGroupedField(counts, entry[field])
    }
  }

  const containers = {}
  for (const [id, minerCount] of Object.entries(counts)) {
    containers[id] = { minerCount }
  }
  return { containers }
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
      fields: { id: 1, type: 1 }
    }),
    ctx.dataProxy.requestDataAllPages(RPC_METHODS.LIST_THINGS, {
      query: { tags: { $in: [WORKER_TAGS.CONTAINER] } },
      fields: { id: 1, tags: 1, 'info.container': 1, 'info.nominalMinerCapacity': 1 }
    }),
    getMinerCountsByContainer(ctx)
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
  const { start, end } = resolveStartEnd(ctx, req)

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
  // An explicit start/end is a true UTC instant, same as the computed defaults below.
  const start = resolveOptionalTimeMs(req, req.query.start, now - METRICS_TIME.ONE_MONTH_MS)
  const end = resolveOptionalTimeMs(req, req.query.end, now)
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
  const { start, end } = resolveStartEnd(ctx, req)

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
  // An explicit start/end is a true UTC instant, same as the computed defaults below.
  const start = resolveOptionalTimeMs(req, req.query.start, now - METRICS_TIME.ONE_DAY_MS)
  const end = resolveOptionalTimeMs(req, req.query.end, now)
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

  const { start, end } = resolveStartEnd(ctx, req)

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

const HOUR_MS = 60 * 60 * 1000

// Maps each forecast hour to the inputs the downtime split needs: whether the
// forecast said not to mine (manualOverrideMine forces mining regardless of
// the stored decision) and how much energy was available. availableW is the
// power-production input (MW for the whole hour); a legacy yes/no flag maps to
// full capacity / zero, and null means "assume full capacity".
function indexForecastDecisionsByHour (forecastResults) {
  const byHour = new Map()
  for (const orkResult of Array.isArray(forecastResults) ? forecastResults : []) {
    for (const payload of Array.isArray(orkResult) ? orkResult : []) {
      if (!Array.isArray(payload?.hourlyForecast)) continue
      for (const item of payload.hourlyForecast) {
        const start = Number(item?.start)
        if (!Number.isFinite(start)) continue
        const hourTs = Math.floor(start / HOUR_MS) * HOUR_MS
        // wait_prod / wait_spot hours are not mining hours either
        const notMining = item.manualOverrideMine === true
          ? false
          : item.decision !== 'mine'
        // hours without a power input carry availableMw: null, which is "no
        // input" (fall back to the legacy flag), not an explicit 0 MW
        const availableMw = typeof item.availableMw === 'number' ? item.availableMw : NaN
        const availableW = Number.isFinite(availableMw) && availableMw >= 0
          ? availableMw * 1e6
          : normalizeAvailability(item) === 0 ? 0 : null
        byHour.set(hourTs, { notMining, availableW })
      }
    }
  }
  return byHour
}

// Hourly {ts, timeRange, powerW} rows from the tail-log aggregation the site
// path reads.
function toHourlyPower (entries) {
  return entries.map(val => {
    const ts = parseEntryTs(val.ts)
    const timeRange = parseEntryTimeRange(val.ts)
    return { ts, ...(timeRange && { timeRange }), powerW: Number(val[AGGR_FIELDS.SITE_POWER]) || 0 }
  })
}

// Splits each hour's downtime into three buckets: curtailment is the energy
// that was never available (nominal minus the power-production input, as a
// share of nominal), energy sold is the available energy routed to the grid
// on a not-mining hour, and the operational rate on a mining hour is the gap
// between the hour's available energy and the metered draw, as a share of the
// available energy — mining is assumed to take the full production, so this
// bucket can exceed the nominal-based downtime when more than nominal was
// available. Hours without a forecast entry count as 'mine' at full
// availability, so an unexplained shortfall surfaces as an operational issue
// rather than being hidden as curtailment.
//
// The forecast behind the split is site-level, so a phase request passes
// decisionByHour: null and carries the downtime rate alone — attributing a
// phase's shortfall to curtailment or sales would be an assumption, not data.
function buildHourlyDowntime (rows, nominalPowerW, decisionByHour) {
  return rows.map(({ ts, timeRange, powerW }) => {
    let downtimeRate = null
    let curtailmentRate = null
    let energySoldRate = null
    let operationalIssuesRate = null
    if (nominalPowerW) {
      // min(1): a remainder phase hour can read negative when the manual
      // entries overshoot the meter; that is a data problem, not >100% downtime.
      downtimeRate = Math.min(1, Math.max(0, nominalPowerW - powerW) / nominalPowerW)
    }
    if (nominalPowerW && decisionByHour) {
      const hourTs = Math.floor(ts / HOUR_MS) * HOUR_MS
      const hour = decisionByHour.get(hourTs)
      const availableW = hour?.availableW ?? nominalPowerW

      // capped at the observed downtime so the three buckets always sum to it
      // (a site mining on purchased energy has no available production, yet no
      // downtime either)
      curtailmentRate = Math.min(
        Math.max(0, nominalPowerW - availableW) / nominalPowerW,
        downtimeRate
      )
      energySoldRate = hour?.notMining && availableW > 0
        ? Math.min(availableW / nominalPowerW, downtimeRate - curtailmentRate)
        : 0
      operationalIssuesRate = !hour?.notMining && availableW > 0
        ? Math.max(0, availableW - powerW) / availableW
        : Math.max(0, downtimeRate - curtailmentRate - energySoldRate)
    }

    return {
      ts,
      ...(timeRange && { timeRange }),
      powerW,
      nominalPowerW,
      downtimeRate,
      curtailmentRate,
      energySoldRate,
      operationalIssuesRate
    }
  })
}

// Daily rates are the mean of the hourly rates over hours that have data, so
// gaps in the stat log don't read as 100% downtime. Days are local calendar days in
// `timezone`, the same grid finance/* buckets on, so pages that render both line up.
function aggregateDowntimeDaily (hourlyLog, timezone) {
  const byDay = new Map()
  for (const entry of hourlyLog) {
    const dayTs = localDayStart(entry.ts, timezone)
    if (!byDay.has(dayTs)) byDay.set(dayTs, [])
    byDay.get(dayTs).push(entry)
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => a - b)
    .map(([dayTs, hours]) => ({
      ts: dayTs,
      // A local day is 23-25h across a DST shift, so its end is the next day's start.
      timeRange: { startTs: dayTs, endTs: nextLocalDayStart(dayTs, timezone) - 1 },
      powerW: hours.reduce((sum, h) => sum + h.powerW, 0) / hours.length,
      nominalPowerW: hours[0].nominalPowerW,
      downtimeRate: meanOfField(hours, 'downtimeRate'),
      curtailmentRate: meanOfField(hours, 'curtailmentRate'),
      energySoldRate: meanOfField(hours, 'energySoldRate'),
      operationalIssuesRate: meanOfField(hours, 'operationalIssuesRate')
    }))
}

function meanOfField (entries, field) {
  const values = entries
    .map(entry => entry[field])
    .filter(value => value !== null && value !== undefined)
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null
}

function calculateDowntimeSummary (log, nominalPowerW, hasForecastData) {
  const powers = log.map(entry => entry.powerW)
  return {
    avgDowntimeRate: meanOfField(log, 'downtimeRate'),
    avgCurtailmentRate: meanOfField(log, 'curtailmentRate'),
    avgEnergySoldRate: meanOfField(log, 'energySoldRate'),
    avgOperationalIssuesRate: meanOfField(log, 'operationalIssuesRate'),
    avgPowerW: meanOfField(log, 'powerW'),
    minPowerW: powers.length ? Math.min(...powers) : null,
    maxPowerW: powers.length ? Math.max(...powers) : null,
    nominalPowerW,
    hasForecastData
  }
}

function resolveDowntimeInterval (start, end, interval) {
  return interval || ((end - start) <= METRICS_TIME.TWO_DAYS_MS ? '1h' : '1d')
}

// Only the daily rollup cuts on the zone; hourly buckets are the same UTC instants in any
// whole-hour zone. Runs before validation, so start/end may still be raw query strings.
function downtimeUsesTimezone (req) {
  const { start, end, interval } = req.query
  return resolveDowntimeInterval(Number(start), Number(end), interval) === '1d'
}

// A phase divides by its own nominal, not the site's; a phase missing from
// the ork global config's phaseNominals map fails loudly instead of silently
// reporting downtime against the whole site.
function resolvePhaseNominalPowerW (globalConfigResults, phase) {
  const powerMw = lPhases.getPhaseNominals(globalConfigResults, phase.id)?.powerMw
  if (!Number.isFinite(powerMw) || powerMw <= 0) throw lPhases.phaseError('ERR_PHASE_NOMINAL_MISSING')
  return powerMw * 1e6
}

async function getDowntime (ctx, req) {
  const phase = lPhases.resolvePhase(ctx, req)
  const { start, end, timezone } = resolveStartEnd(ctx, req)
  const interval = resolveDowntimeInterval(start, end, req.query.interval)

  // A phase runs the same per-hour formula over its own consumption series
  // (manual entries, or its meter minus them) and its own nominal. The
  // curtailment / energy-sold / op-issues split stays null: the forecast it
  // comes from is site-level and says nothing about whose power it was.
  // Hours the series has no entry for are absent, not zero, so a coverage gap
  // reads as unknown rather than 100% downtime — same as a site meter gap.
  if (phase) {
    const [{ log: hourlyRows }, globalConfigRes] = await Promise.all([
      getConsumption(ctx, { ...req, query: { ...req.query, interval: '1h' } }),
      ctx.dataProxy.requestDataMap(RPC_METHODS.GLOBAL_CONFIG, {
        fields: { phaseNominals: 1 }
      })
    ])
    const nominalPowerW = resolvePhaseNominalPowerW(globalConfigRes, phase)
    const hourly = buildHourlyDowntime(hourlyRows, nominalPowerW, null)
    const log = interval === '1d' ? aggregateDowntimeDaily(hourly, timezone) : hourly
    return { log, summary: calculateDowntimeSummary(log, nominalPowerW, false) }
  }

  // Attribution is decided per forecast hour, so power is always fetched at
  // hourly resolution and rolled up to days afterwards when interval=1d.
  const { key, groupRange } = getIntervalConfig('1h')

  const requestParams = isCentralDCSEnabled(ctx)
    ? { type: WORKER_TYPES.DCS, tag: getDCSTag(ctx) }
    : { type: WORKER_TYPES.POWERMETER, tag: WORKER_TAGS.POWERMETER }

  const [powerRes, forecastRes, globalConfigRes] = await Promise.all([
    ctx.dataProxy.requestData(RPC_METHODS.TAIL_LOG, {
      ...requestParams,
      key,
      groupRange,
      shouldCalculateAvg: true,
      start,
      end,
      fields: { [LOG_FIELDS.SITE_POWER]: 1 },
      aggrFields: { [AGGR_FIELDS.SITE_POWER]: 1 }
    }),
    // A site without an electricity worker still gets a downtime report; every
    // shortfall is then attributed to operational issues.
    ctx.dataProxy.requestDataMap(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.ELECTRICITY,
      query: { key: ELECTRICITY_EXT_DATA_KEYS.FORECAST_HISTORY },
      start,
      end
    }).catch(() => []),
    ctx.dataProxy.requestDataMap(RPC_METHODS.GLOBAL_CONFIG, {
      fields: { nominalPowerAvailability_MW: 1, nominalAvailablePowerMWh: 1 }
    })
  ])

  // Some deployments store the site capacity as nominalAvailablePowerMWh
  // (MWh available per hour, i.e. MW) instead of nominalPowerAvailability_MW.
  const globalConfig = extractGlobalConfig(globalConfigRes)
  const nominalMW = globalConfig.nominalPowerAvailability_MW ||
    globalConfig.nominalAvailablePowerMWh
  const nominalPowerW = nominalMW > 0 ? nominalMW * 1000000 : null

  const decisionByHour = indexForecastDecisionsByHour(forecastRes)
  const hourly = buildHourlyDowntime(toHourlyPower(firstOrkEntries(powerRes)), nominalPowerW, decisionByHour)
  const log = interval === '1d' ? aggregateDowntimeDaily(hourly, timezone) : hourly
  const summary = calculateDowntimeSummary(log, nominalPowerW, decisionByHour.size > 0)

  return { log, summary }
}

// Serves the dashboard hash-rate chart's per-pool series, which the UI used to
// assemble client-side by paginating 30-90 days of raw 5-min stats-history
// rows through /auth/ext-data. Buckets are floor-aligned and hashrate is
// averaged across every stats entry of a poolType in the bucket - deliberately
// the same semantics the chart's downsampling produced, so the swap is not a
// visual change. stats entries are per account and orks report disjoint racks,
// so a multi-account pool (or one spread over orks) plots the per-account
// average, not the pool total; balance-history-style avg-per-account-then-sum
// would change the plotted numbers and is left as a deliberate follow-up.
// Values stay in H/s; the UI converts.
function bucketPoolHashrate (results, intervalMs, accounts = null) {
  const buckets = new Map()

  for (const windowRes of results) {
    for (const orkRows of windowRes) {
      if (!Array.isArray(orkRows)) continue
      for (const row of orkRows) {
        const ts = Number(row?.ts)
        if (!Number.isFinite(ts) || !Array.isArray(row.stats)) continue

        const bucketTs = Math.floor(ts / intervalMs) * intervalMs
        let pools = buckets.get(bucketTs)
        if (!pools) {
          pools = new Map()
          buckets.set(bucketTs, pools)
        }

        for (const stat of row.stats) {
          if (!stat?.poolType) continue
          if (accounts && !accounts.has(`${stat.poolType}:${stat.username}`)) continue
          // Average per account before summing across accounts: pooling the
          // samples would average a 100 TH/s and a 50 TH/s account into 75
          // instead of the 150 the site actually hashes.
          const key = `${stat.poolType}:${stat.username}`
          const acc = pools.get(key) || { poolType: stat.poolType, sum: 0, count: 0 }
          acc.sum += stat.hashrate || 0
          acc.count++
          pools.set(key, acc)
        }
      }
    }
  }

  return [...buckets.entries()]
    .sort(([tsA], [tsB]) => tsA - tsB)
    .map(([ts, pools]) => {
      const byPool = new Map()
      for (const { poolType, sum, count } of pools.values()) {
        byPool.set(poolType, (byPool.get(poolType) || 0) + sum / count)
      }
      return {
        ts,
        stats: [...byPool.entries()].map(([poolType, hashrate]) => ({ poolType, hashrate }))
      }
    })
}

async function getPoolHashrate (ctx, req) {
  const phase = lPhases.resolvePhase(ctx, req)
  const accounts = phase ? lPhases.getPhaseAccountKeys(phase) : null
  const intervalMs = POOL_HASHRATE_INTERVALS_MS[req.query.interval]
  const end = Date.now()
  const start = end - req.query.lookbackDays * METRICS_TIME.ONE_DAY_MS

  // The pool workers stream the whole start..end range in one response, so
  // split long lookbacks into week-sized windows to keep each RPC well under
  // the proxy timeout. Windows are inclusive on both ends worker-side, hence
  // the -1ms so rows on the seam are not fetched twice.
  const windows = []
  for (let windowStart = start; windowStart < end; windowStart += METRICS_TIME.SEVEN_DAYS_MS) {
    windows.push({
      start: windowStart,
      end: Math.min(windowStart + METRICS_TIME.SEVEN_DAYS_MS - 1, end)
    })
  }

  const results = await Promise.all(windows.map((window) =>
    ctx.dataProxy.requestDataMap(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MINERPOOL,
      query: {
        key: MINERPOOL_EXT_DATA_KEYS.STATS_HISTORY,
        start: window.start,
        end: window.end,
        fields: { ts: 1, 'stats.poolType': 1, 'stats.hashrate': 1, 'stats.username': 1 }
      }
    })
  ))

  return { log: bucketPoolHashrate(results, intervalMs, accounts) }
}

module.exports = {
  wantsMonthlyRollup,
  downtimeUsesTimezone,
  ...require('../../metrics.utils'),
  getHashrate,
  getMonthlyHashrate,
  monthlyHashesCache,
  dailyHashesCache,
  calculateHashrateSummary,
  calculateGroupedHashrateSummary,
  getConsumption,
  rollupLocalConsumption,
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
  getMinerCountsByContainer,
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
  calculateCoolingSummary,
  getDowntime,
  indexForecastDecisionsByHour,
  toHourlyPower,
  buildHourlyDowntime,
  aggregateDowntimeDaily,
  calculateDowntimeSummary,
  getPoolHashrate,
  bucketPoolHashrate
}
