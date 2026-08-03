'use strict'

const async = require('async')
const {
  RPC_CONCURRENCY_LIMIT,
  RPC_PAGE_LIMIT,
  RPC_RETRYABLE_ERRORS,
  RPC_RETRYABLE_METHODS,
  RPC_MAX_ATTEMPTS,
  RPC_RETRY_DELAY
} = require('./constants')

const getRpcTimeout = (conf) => conf?.rpcTimeout || 15000

const _isRetryableRpcError = (err) => {
  const message = err?.message || ''
  return RPC_RETRYABLE_ERRORS.some((pattern) => message.includes(pattern))
}

const _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A single dropped protomux-rpc channel would otherwise reject the whole
 * request, so retry the transient channel failures before giving up. Any other
 * error, and the final attempt, propagate unchanged.
 *
 * Retries are confined to the read methods in RPC_RETRYABLE_METHODS: a channel
 * can drop after the ork applied the request, so retrying a write risks
 * executing it twice. Writes keep the pre-existing behaviour of failing on the
 * first CHANNEL_CLOSED, which is the safe direction for a miner control action.
 */
const _jRequest = async (ctx, publicKey, method, params, timeout) => {
  const retryable = RPC_RETRYABLE_METHODS.has(method)

  for (let attempt = 1; ; attempt++) {
    try {
      return await ctx.net_r0.jRequest(publicKey, method, params, { timeout })
    } catch (err) {
      if (!retryable || attempt >= RPC_MAX_ATTEMPTS || !_isRetryableRpcError(err)) throw err

      console.warn(
        `[DataProxy] rpc ${method} failed with "${err.message}", ` +
          `retrying (${attempt}/${RPC_MAX_ATTEMPTS - 1})`
      )

      await _sleep(RPC_RETRY_DELAY * attempt)
    }
  }
}

const _rpcEachLimit = async (ctx, method, params, errorHandler = null) => {
  const results = []
  const concurrency = ctx.conf?.rpcConcurrencyLimit || RPC_CONCURRENCY_LIMIT
  const timeout = getRpcTimeout(ctx.conf)

  await async.eachLimit(ctx.conf.orks, concurrency, async (store) => {
    try {
      const res = await _jRequest(ctx, store.rpcPublicKey, method, params, timeout)
      if (errorHandler) {
        errorHandler(res, results)
      } else {
        results.push(res)
      }
    } catch (err) {
      if (errorHandler) {
        errorHandler({ error: err.message }, results)
      } else {
        results.push({ error: err.message })
      }
    }
  })

  return results
}

/**
 * Returns one entry per ork that answered. A store that fails after its retries
 * is dropped rather than rejecting the whole request, so a single flaky ork
 * degrades the response instead of losing it. When every store fails there is no
 * data to degrade to, so the first error propagates — callers must not mistake a
 * total outage for an empty result set.
 *
 * Note the returned entries are positionally compacted: with a failed store the
 * array is shorter, so callers cannot map index back to ctx.conf.orks.
 */
const _rpcMapLimit = async (ctx, method, params) => {
  const concurrency = ctx.conf?.rpcConcurrencyLimit || RPC_CONCURRENCY_LIMIT
  const timeout = getRpcTimeout(ctx.conf)

  const settled = await async.mapLimit(ctx.conf.orks, concurrency, async (store) => {
    try {
      return { data: await _jRequest(ctx, store.rpcPublicKey, method, params, timeout) }
    } catch (err) {
      console.warn(`[DataProxy] rpc ${method} failed for an ork: ${err.message}`)
      return { err }
    }
  })

  const succeeded = settled.filter((result) => !result.err)

  if (settled.length && !succeeded.length) throw settled[0].err

  return succeeded.map(({ data }) => data)
}

const _rpcMapAllPages = async (ctx, method, params, pageLimit = RPC_PAGE_LIMIT) => {
  const concurrency = ctx.conf?.rpcConcurrencyLimit || RPC_CONCURRENCY_LIMIT
  const timeout = getRpcTimeout(ctx.conf)

  return await async.mapLimit(ctx.conf.orks, concurrency, async (store) => {
    const allItems = []
    let offset = 0

    while (true) {
      const batch = await _jRequest(
        ctx,
        store.rpcPublicKey,
        method,
        { ...params, limit: pageLimit, offset },
        timeout
      )

      if (!Array.isArray(batch) || batch.length === 0) break
      allItems.push(...batch)
      if (batch.length < pageLimit) break
      offset += pageLimit
    }

    return allItems
  })
}

const _orkCall = async (ctx, method, params) => {
  return ctx.ork[method](params)
}

const createDataProxy = (ctx) => {
  return {
    async requestData (method, params, errorHandler = null) {
      if (ctx.isRpcMode === false) return _orkCall(ctx, method, params)
      return _rpcEachLimit(ctx, method, params, errorHandler)
    },

    async requestDataMap (method, params) {
      if (ctx.isRpcMode === false) return _orkCall(ctx, method, params)
      return _rpcMapLimit(ctx, method, params)
    },

    async requestDataAllPages (method, params, pageLimit = RPC_PAGE_LIMIT) {
      if (ctx.isRpcMode === false) return _orkCall(ctx, method, params)
      return _rpcMapAllPages(ctx, method, params, pageLimit)
    }
  }
}

module.exports = {
  createDataProxy
}
