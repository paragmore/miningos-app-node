'use strict'

const {
  BTC_SATS,
  PRICE_BUCKET_MS,
  RPC_METHODS,
  WORKER_TYPES,
  MEMPOOL_EXT_DATA_KEYS
} = require('../../constants')
const { localDayStart } = require('../../utils')
const {
  assertTimezone,
  resolveTimezone,
  resolveStartEnd
} = require('../../metrics.utils')

function validateStartEnd (req) {
  const start = Number(req.query.start)
  const end = Number(req.query.end)

  if (!start || !end) {
    throw new Error('ERR_MISSING_START_END')
  }

  if (start >= end) {
    throw new Error('ERR_INVALID_DATE_RANGE')
  }

  return { start, end }
}

function historyLimit (start, end) {
  return Math.ceil((end - start) / 86400000) + 1
}

// Worker timestamps arrive in whatever shape the upstream pool API uses: unix seconds
// (f2pool `created_at`), unix ms, or an ISO-8601 string (ocean `ts`, e.g. "2026-05-28T16:46:30").
// Anything it can't parse comes back as 0, and every caller skips a 0 before bucketing, so
// the record is dropped without a trace - every shape has to be handled here rather than
// at the call sites.
function normalizeTimestampMs (ts) {
  if (!ts) return 0

  if (typeof ts === 'string') {
    const numeric = Number(ts)
    if (!Number.isNaN(numeric)) return normalizeTimestampMs(numeric)

    // Ocean sends no timezone designator; these timestamps are UTC, and Date.parse would
    // otherwise read them as host-local and shift the day bucket.
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(ts)
    const parsed = Date.parse(hasZone ? ts : `${ts}Z`)
    return Number.isNaN(parsed) ? 0 : parsed
  }

  if (typeof ts !== 'number' || !Number.isFinite(ts)) return 0

  return ts < 1e12 ? ts * 1000 : ts
}

// Returns the day-bucketed BTC sums the BTC-denominated views rely on, plus the
// individual transactions behind them. USD valuation needs the latter: a payout
// at 00:05 and one at 23:55 are worth different amounts, and the day bucket has
// already thrown that away.
// `opts.start`/`opts.end` drop transactions whose own (mining) date falls outside the
// window: the store selects records by their settle time, so a payout inside the window
// can still carry a mining_date before or after it.
function processTransactions (results, opts, timezone) {
  const trackFees = opts && opts.trackFees
  const start = Number.isFinite(opts?.start) ? opts.start : -Infinity
  const end = Number.isFinite(opts?.end) ? opts.end : Infinity
  const daily = {}
  const txEntries = []
  for (const res of results) {
    if (!res || res.error) continue
    const data = Array.isArray(res) ? res : (res.data || res.result || [])
    if (!Array.isArray(data)) continue
    for (const tx of data) {
      if (!tx) continue
      const txList = tx.data || tx.transactions || tx
      if (!Array.isArray(txList)) continue
      for (const t of txList) {
        if (!t) continue
        const rawTs = t.mining_extra?.mining_date || t.ts || t.created_at || t.timestamp || t.time
        const rawMs = normalizeTimestampMs(rawTs)
        if (!rawMs || rawMs < start || rawMs > end) continue
        const ts = localDayStart(rawMs, timezone)
        const day = daily[ts] ??= trackFees
          ? { revenueBTC: 0, feesBTC: 0 }
          : { revenueBTC: 0 }

        let amountBTC = 0
        let feeBTC = 0
        if (t.satoshis_net_earned) {
          amountBTC = Math.abs(t.satoshis_net_earned) / BTC_SATS
          feeBTC = (t.fees_colected_satoshis || 0) / BTC_SATS
        } else {
          amountBTC = Math.abs(t.changed_balance || t.amount || t.value || 0)
          feeBTC = (t.mining_extra?.tx_fee || 0)
        }

        day.revenueBTC += amountBTC
        if (trackFees) day.feesBTC += feeBTC

        txEntries.push({ ts: rawMs, amountBTC, feeBTC })
      }
    }
  }
  return { daily, txEntries }
}

function priceBucket (ts) {
  return Math.floor(ts / PRICE_BUCKET_MS) * PRICE_BUCKET_MS
}

// Far above any realistic payout density (Ocean finds ~1-3 blocks a day, so a
// year is ~1500 distinct buckets); purely a guard against pathological input.
const MAX_PRICE_BUCKETS_PER_REQUEST = 5000

// Tells a caller whether every payout in the response was valued at the price of
// the moment it arrived, or whether some fell back to a daily price. Anything
// other than 0 means the server-side backfill still owes this range.
function pricingStatus (missingPriceBuckets) {
  return {
    missingPriceBuckets,
    pricingComplete: missingPriceBuckets === 0
  }
}

// The mempool worker answers from its own cache and never fetches, so this stays
// well inside the RPC timeout.
//
// The reply arrives nested: the ork wraps each rack's object in an array and
// concatenates across racks, then one such array comes back per ork. Racks
// without a mempool worker contribute nothing. So walk whatever shape arrives
// and merge every price map found - a missed layer here would silently price
// every payout off the daily fallback.
async function fetchBucketPrices (ctx, buckets) {
  if (!buckets.length) return {}

  const results = await ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
    type: WORKER_TYPES.MEMPOOL,
    query: { key: MEMPOOL_EXT_DATA_KEYS.PRICE_AT_TIMESTAMPS, timestamps: buckets }
  })

  const prices = {}
  const collect = (node) => {
    if (!node || node.error) return
    if (Array.isArray(node)) return node.forEach(collect)
    if (node.prices) return Object.assign(prices, node.prices)
    if (node.data || node.result) collect(node.data || node.result)
  }
  collect(results)

  return prices
}

/**
 * Values every payout and rebate at the BTC price recorded for the 5-minute
 * bucket it actually landed in, rather than one price for the whole day.
 *
 * A bucket with no recorded price falls back to the day price, which is exactly
 * the old behaviour - so accuracy degrades to the previous baseline instead of
 * breaking. Each day reports how many of its payouts needed that fallback, so
 * it is never silent; the server-side backfill is what clears them. A count
 * rather than a flag because `aggregateByPeriod` sums unknown fields, and a
 * count still means something once days are rolled up into months.
 */
async function priceDailyRevenue (ctx, {
  txEntries = [],
  rebates = [],
  dailyPrices = {},
  currentBtcPrice = 0,
  timezone = 'UTC',
  trackFees = false
} = {}) {
  const payouts = txEntries.map((t) => ({ ...t, isRebate: false }))
  const validRebates = rebates.filter((r) => Number.isFinite(r?.ts) && Number.isFinite(r?.amountBTC))

  for (const r of validRebates) {
    payouts.push({
      ts: r.ts,
      amountBTC: r.amountBTC,
      feeBTC: 0,
      // Priced when the rebate was recorded; only older rows lack it.
      storedPriceUSD: Number.isFinite(r.priceUSD) ? r.priceUSD : null,
      isRebate: true
    })
  }

  // A zero-value payout needs no price: it contributes nothing to revenueUSD,
  // so it must neither cost a bucket lookup nor flag the range as unpriced.
  const priceable = (p) => p.amountBTC > 0 || p.feeBTC > 0

  const needed = [...new Set(
    payouts.filter((p) => !p.storedPriceUSD && priceable(p)).map((p) => priceBucket(p.ts))
  )]

  // Bounds the RPC payload and the worker-side scan on pathological ranges; a
  // request past the cap could only ever time out at the ork and fall back
  // wholesale anyway. Newest buckets win the slots - they are the ones the
  // sampler has actually recorded - and everything past the cap degrades to
  // the daily price and is reported as unpriced.
  let requested = needed
  if (needed.length > MAX_PRICE_BUCKETS_PER_REQUEST) {
    requested = [...needed].sort((a, b) => b - a).slice(0, MAX_PRICE_BUCKETS_PER_REQUEST)
    console.warn(
      new Date().toISOString(),
      `WARN_PRICE_BUCKETS_CAPPED requested=${needed.length} cap=${MAX_PRICE_BUCKETS_PER_REQUEST}`
    )
  }

  // requestData throws when every ork fails; per-ork failures arrive as
  // {error} entries that fetchBucketPrices already skips. Either way the
  // response must not die over pricing - everything falls back to the daily
  // price and is reported as unpriced, exactly the pre-feature behaviour.
  let bucketPrices = {}
  try {
    bucketPrices = await fetchBucketPrices(ctx, requested)
  } catch (err) {
    console.error(new Date().toISOString(), 'ERR_FETCH_BUCKET_PRICES', err.message)
  }

  const daily = {}
  const missingBuckets = new Set()

  for (const p of payouts) {
    const dayTs = localDayStart(p.ts, timezone)
    const day = daily[dayTs] ??= {
      revenueBTC: 0,
      payoutBTC: 0,
      rebateBTC: 0,
      revenueUSD: 0,
      feesBTC: 0,
      feesUSD: 0,
      unpricedPayouts: 0
    }

    const bucketTs = priceBucket(p.ts)
    const exactPrice = p.storedPriceUSD || bucketPrices[bucketTs]
    const price = exactPrice || dailyPrices[dayTs] || currentBtcPrice || 0

    if (!exactPrice && priceable(p)) {
      day.unpricedPayouts++
      missingBuckets.add(bucketTs)
    }

    day.revenueBTC += p.amountBTC
    day.revenueUSD += p.amountBTC * price
    if (p.isRebate) day.rebateBTC += p.amountBTC
    else day.payoutBTC += p.amountBTC

    if (trackFees) {
      day.feesBTC += p.feeBTC
      day.feesUSD += p.feeBTC * price
    }
  }

  for (const [dayTs, day] of Object.entries(daily)) {
    // The blended price the day's revenue actually realised, so the reported
    // btcPrice stays consistent with revenueUSD instead of contradicting it.
    day.btcPrice = day.revenueBTC > 0
      ? day.revenueUSD / day.revenueBTC
      : (dailyPrices[dayTs] || currentBtcPrice || 0)
  }

  return { daily, missingPriceBuckets: missingBuckets.size }
}

function extractCurrentPrice (results) {
  for (const res of results) {
    if (!res || res.error) continue

    // Flat entry format: [{currentPrice: N}, {priceUSD: N}, {price: N}]
    const data = Array.isArray(res) ? res : [res]
    for (const entry of data) {
      if (!entry) continue
      if (entry.currentPrice) return entry.currentPrice
      if (entry.priceUSD) return entry.priceUSD
      if (entry.price) return entry.price

      // Nested EBITDA format: {data: N} or {data: {USD: N}} or {result: ...}
      const nested = entry.data || entry.result
      if (nested) {
        if (typeof nested === 'number') return nested
        if (typeof nested === 'object') {
          if (nested.USD) return nested.USD
          if (nested.price) return nested.price
          if (nested.current_price) return nested.current_price
        }
      }
    }
  }
  return 0
}

function processBlockData (results, timezone) {
  const daily = {}
  for (const res of results) {
    if (!res || res.error) continue
    const data = Array.isArray(res) ? res : (res.data || res.result || [])
    if (!Array.isArray(data)) continue
    for (const entry of data) {
      if (!entry) continue
      const rawTs = entry.ts || entry.timestamp || entry.time
      const items = rawTs ? [entry] : (entry.data || entry.blocks || entry)
      if (Array.isArray(items)) {
        for (const item of items) {
          if (!item) continue
          const itemTs = item.ts || item.timestamp || item.time
          const itemMs = normalizeTimestampMs(itemTs)
          if (!itemMs) continue
          const ts = localDayStart(itemMs, timezone)
          if (!daily[ts]) daily[ts] = { blockReward: 0, blockTotalFees: 0, blockSize: 0 }
          daily[ts].blockReward += (item.blockReward || item.block_reward || item.subsidy || 0)
          daily[ts].blockTotalFees += (item.blockTotalFees || item.block_total_fees || item.totalFees || item.total_fees || 0)
          daily[ts].blockSize += (item.blockSize || item.block_size || item.size || 0)
        }
      } else if (typeof items === 'object') {
        for (const [key, val] of Object.entries(items)) {
          const keyMs = Number(key)
          if (!keyMs) continue
          const ts = localDayStart(keyMs, timezone)
          if (!daily[ts]) daily[ts] = { blockReward: 0, blockTotalFees: 0, blockSize: 0 }
          if (typeof val === 'object') {
            daily[ts].blockReward += (val.blockReward || val.block_reward || val.subsidy || 0)
            daily[ts].blockTotalFees += (val.blockTotalFees || val.block_total_fees || val.totalFees || val.total_fees || 0)
            daily[ts].blockSize += (val.blockSize || val.block_size || val.size || 0)
          }
        }
      }
    }
  }
  return daily
}

module.exports = {
  validateStartEnd,
  assertTimezone,
  resolveTimezone,
  resolveStartEnd,
  normalizeTimestampMs,
  processTransactions,
  extractCurrentPrice,
  processBlockData,
  historyLimit,
  priceBucket,
  fetchBucketPrices,
  priceDailyRevenue,
  pricingStatus
}
