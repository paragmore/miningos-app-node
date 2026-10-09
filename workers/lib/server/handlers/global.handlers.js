'use strict'
const gLibUtilBase = require('@bitfinex/lib-js-util-base')
const { GLOBAL_DATA_TYPES, LOCKED_TIMEZONE_DEFAULT, POOL_REBATE_SOURCES } = require('../../constants')
const { parseJsonQueryParam, sanitizeIncludeFields } = require('../../utils')
const {
  getAutoPoolRebates,
  getCombinedPoolRebates,
  updateAutoPoolRebate,
  deleteAutoPoolRebate
} = require('./rebates.utils')
const { priceBucket, fetchBucketPrices } = require('./finance.utils')

async function getGlobalData (ctx, req) {
  const type = req.query.type
  const groupBy = req.query.groupBy

  const range = {}
  const opts = {}
  if (req.query.gt) range.gt = req.query.gt
  if (req.query.gte) range.gte = req.query.gte
  if (req.query.lt) range.lt = req.query.lt
  if (req.query.lte) range.lte = req.query.lte
  if (req.query.limit) opts.limit = req.query.limit

  if (req.query.query) {
    req.query.query = parseJsonQueryParam(req.query.query, 'ERR_QUERY_INVALID_JSON')
  }
  if (req.query.sort) {
    req.query.sort = parseJsonQueryParam(req.query.sort, 'ERR_SORT_INVALID_JSON')
  }

  if (req.query.fields) {
    req.query.fields = sanitizeIncludeFields(parseJsonQueryParam(req.query.fields, 'ERR_FIELDS_INVALID_JSON'))
  }

  if (type === GLOBAL_DATA_TYPES.POOL_REBATES) {
    return await getPoolRebatesData(ctx, req, range)
  }

  return await ctx.globalDataLib.getGlobalData({
    type,
    range,
    opts,
    query: req.query.query,
    fields: req.query.fields,
    sort: req.query.sort,
    offset: req.query.offset,
    limit: req.query.limit,
    groupBy,
    model: req.query.model
  })
}

// Manual rows (global data) merged with the synced rows the mempool worker
// owns, then run through the same mingo filtering (query/fields/sort/offset/
// limit/groupBy) the generic path applies - dedupe happens before projection,
// so a fields selection without txid cannot break it.
async function getPoolRebatesData (ctx, req, range) {
  const combined = await getCombinedPoolRebates(ctx, {
    start: range.gte ?? range.gt,
    end: range.lte ?? range.lt
  })

  const bounded = combined.filter((row) =>
    (range.gt === undefined || row.ts > range.gt) &&
    (range.gte === undefined || row.ts >= range.gte) &&
    (range.lt === undefined || row.ts < range.lt) &&
    (range.lte === undefined || row.ts <= range.lte))

  const offset = req.query.offset !== undefined ? Number(req.query.offset) : undefined
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined

  const res = ctx.globalDataLib.filterData(bounded, {
    queryJSON: req.query.query,
    fields: req.query.fields,
    sort: req.query.sort,
    offset: Number.isFinite(offset) ? offset : undefined,
    limit: Number.isFinite(limit) ? limit : undefined
  })

  if (req.query.groupBy) {
    return gLibUtilBase.groupBy(res, (row) => row[req.query.groupBy])
  }

  return res
}

async function setGlobalData (ctx, req) {
  const data = req.body.data
  const type = req.query.type

  if (type === GLOBAL_DATA_TYPES.POOL_REBATES) {
    return await setPoolRebatesData(ctx, data)
  }

  return await ctx.globalDataLib.setGlobalData(data, type)
}

async function setPoolRebatesData (ctx, data) {
  // Deletes always tombstone the txid in the mempool worker (idempotent, even
  // for manual rows), so a removed transaction can never return via the sync.
  if (data?.remove) {
    if (data.source === POOL_REBATE_SOURCES.AUTO) return await deleteAutoPoolRebate(ctx, data.txid)
    await ctx.globalDataLib.setGlobalData({ ts: data.ts, remove: true }, GLOBAL_DATA_TYPES.POOL_REBATES)
    if (data.txid) await deleteAutoPoolRebate(ctx, data.txid)
    return true
  }

  // Auto rows live in the mempool worker; edits are forwarded there.
  if (data?.source === POOL_REBATE_SOURCES.AUTO) {
    return await updateAutoPoolRebate(ctx, data)
  }

  // Manual writes also dedupe against the synced set - best effort: with the
  // worker unreachable the write proceeds, and the read-side combine still
  // collapses a clash in favour of the manual row.
  if (data?.txid) {
    const txid = String(data.txid).toLowerCase()
    let auto = []
    try {
      auto = await getAutoPoolRebates(ctx)
    } catch (err) {
      console.error(new Date().toISOString(), 'ERR_POOL_REBATES_AUTO_FETCH', err.message)
    }
    if (auto.some((row) => row.txid === txid)) throw new Error('ERR_DUPLICATE_TXID')
  }

  return await ctx.globalDataLib.setGlobalData(await priceRebateAtReceipt(ctx, data), GLOBAL_DATA_TYPES.POOL_REBATES)
}

// Captures what the rebate was worth when it was received, so its USD value
// stays fixed instead of being re-derived from a daily price later. A rebate
// entered close to real time is a straight cache hit on the mempool worker's
// 5m price store; a backdated one may have no recorded price yet, and must not
// fail the write for it - the finance read path falls back to the daily price
// and the server-side backfill fills the gap. The client never supplies the
// price: it is derived here or not at all.
async function priceRebateAtReceipt (ctx, data) {
  const { priceUSD, ...rest } = data || {}
  if (!Number.isFinite(rest?.ts)) return rest

  try {
    const bucketTs = priceBucket(rest.ts)
    const prices = await fetchBucketPrices(ctx, [bucketTs])
    if (prices[bucketTs]) return { ...rest, priceUSD: prices[bucketTs] }
  } catch (err) {
    console.error(new Date().toISOString(), 'ERR_PRICE_REBATE_AT_RECEIPT', err.message)
  }
  return rest
}

async function getFeatureConfig (ctx) {
  const featureConfig = ctx.conf.featureConfig || {}
  return {
    ...featureConfig,
    // The pool account usernames are backend wiring; clients only need the
    // ids, labels, groups and consumption source.
    ...(Array.isArray(featureConfig.phases) && {
      phases: featureConfig.phases.map(({ pool, ...rest }) => rest)
    }),
    ...await getFeatures(ctx),
    lockedTimezone: featureConfig.lockedTimezone || LOCKED_TIMEZONE_DEFAULT
  }
}

async function getFeatures (ctx) {
  return await ctx.globalDataLib.getGlobalData({ type: GLOBAL_DATA_TYPES.FEATURES })
}

async function setFeatures (ctx, req) {
  const data = req.body.data
  return await ctx.globalDataLib.setGlobalData(data, GLOBAL_DATA_TYPES.FEATURES)
}

async function getGlobalConfig (ctx, req, rep) {
  if (req.query.fields) {
    req.query.fields = sanitizeIncludeFields(parseJsonQueryParam(req.query.fields, 'ERR_FIELDS_INVALID_JSON'))
  }

  return await ctx.dataProxy.requestDataMap('getGlobalConfig', req.query)
}

async function setGlobalConfig (ctx, req, rep) {
  return await ctx.dataProxy.requestDataMap('setGlobalConfig', req.body.data)
}

module.exports = {
  getGlobalData,
  setGlobalData,
  getFeatureConfig,
  getFeatures,
  setFeatures,
  getGlobalConfig,
  setGlobalConfig
}
