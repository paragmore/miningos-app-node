'use strict'

const { parseJsonQueryParam } = require('../../utils')
const { assertSafeMongoQuery } = require('../lib/queryUtils')
const {
  TAIL_LOG_MAX_ROWS,
  TAIL_LOG_BUCKET_MS,
  TAIL_LOG_UNBUCKETED_KEYS
} = require('../../constants')

/**
 * Rejects unbounded ranges whose bucket count would blow past TAIL_LOG_MAX_ROWS,
 * so such a request fails fast with a clear code instead of streaming hundreds of
 * thousands of rows over a single RPC channel. Callers should coarsen the stat key
 * (e.g. stat-5m to stat-3h) for long ranges.
 *
 * A request that supplies its own limit is already bounded by it (the schema caps
 * limit at TAIL_LOG_MAX_LIMIT), so only limitless requests are range-checked. Open
 * ranges are not checked either — with no start/end there is nothing to size.
 *
 * A limitless bounded range on a stat key with no bucket width fails closed with
 * ERR_KEY_NOT_RANGE_CHECKABLE rather than being waved through, so a stat key added
 * upstream without a width here is rejected loudly instead of silently unbounded.
 * stat-rtd is the one deliberate exemption (see TAIL_LOG_UNBUCKETED_KEYS), and
 * non-stat keys are left alone.
 */
const assertRangeWithinRowLimit = (key, start, end, limit) => {
  if (limit) return
  if (!start || !end || end <= start) return
  if (TAIL_LOG_UNBUCKETED_KEYS.has(key)) return

  const bucketMs = TAIL_LOG_BUCKET_MS[key]

  if (!bucketMs) {
    if (typeof key === 'string' && key.startsWith('stat-')) {
      throw new Error('ERR_KEY_NOT_RANGE_CHECKABLE')
    }
    return
  }

  if ((end - start) / bucketMs > TAIL_LOG_MAX_ROWS) throw new Error('ERR_RANGE_TOO_LARGE')
}

async function tailLogRoute (ctx, req, rep) {
  if (req.query.fields) {
    req.query.fields = parseJsonQueryParam(req.query.fields, 'ERR_FIELDS_INVALID_JSON')
  }

  if (req.query.aggrFields) {
    req.query.aggrFields = parseJsonQueryParam(req.query.aggrFields, 'ERR_AGGRFIELDS_INVALID_JSON')
  }

  if (req.query.aggrTimes) {
    req.query.aggrTimes = parseJsonQueryParam(req.query.aggrTimes, 'ERR_AGGRTIMES_INVALID_JSON')

    if (!Array.isArray(req.query.aggrTimes)) {
      throw new Error('ERR_AGGRTIMES_INVALID_ARRAY')
    }
  }

  assertRangeWithinRowLimit(req.query.key, req.query.start, req.query.end, req.query.limit)

  return await ctx.dataProxy.requestDataMap('tailLog', req.query)
}

async function tailLogMultiRoute (ctx, req, rep) {
  if (req.query.keys) {
    req.query.keys = parseJsonQueryParam(req.query.keys, 'ERR_KEYS_INVALID_JSON')

    if (!Array.isArray(req.query.keys)) {
      throw new Error('ERR_KEYS_INVALID_ARRAY')
    }
  }

  if (req.query.fields) {
    req.query.fields = parseJsonQueryParam(req.query.fields, 'ERR_FIELDS_INVALID_JSON')
  }

  if (req.query.aggrFields) {
    req.query.aggrFields = parseJsonQueryParam(req.query.aggrFields, 'ERR_AGGRFIELDS_INVALID_JSON')
  }

  if (req.query.aggrTimes) {
    req.query.aggrTimes = parseJsonQueryParam(req.query.aggrTimes, 'ERR_AGGRTIMES_INVALID_JSON')

    if (!Array.isArray(req.query.aggrTimes)) {
      throw new Error('ERR_AGGRTIMES_INVALID_ARRAY')
    }
  }

  for (const { key } of req.query.keys || []) {
    assertRangeWithinRowLimit(key, req.query.start, req.query.end, req.query.limit)
  }

  return await ctx.dataProxy.requestDataMap('tailLogMulti', req.query)
}

async function tailLogRangeAggrRoute (ctx, req, rep) {
  return await ctx.dataProxy.requestData('tailLogCustomRangeAggr', req.query)
}

async function getHistoryLogRoute (ctx, req) {
  if (req.query.fields) {
    req.query.fields = parseJsonQueryParam(req.query.fields, 'ERR_FIELDS_INVALID_JSON')
  }
  if (req.query.query) {
    req.query.query = parseJsonQueryParam(req.query.query, 'ERR_QUERY_INVALID_JSON')
    assertSafeMongoQuery(req.query.query)
  }

  return await ctx.dataProxy.requestDataMap('getHistoricalLogs', req.query)
}

module.exports = {
  tailLogRoute,
  tailLogMultiRoute,
  tailLogRangeAggrRoute,
  getHistoryLogRoute
}
