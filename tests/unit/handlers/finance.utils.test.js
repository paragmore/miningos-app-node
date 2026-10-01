'use strict'

const test = require('brittle')
const { LOCKED_TIMEZONE_DEFAULT } = require('../../../workers/lib/constants')
const {
  validateStartEnd,
  resolveTimezone,
  resolveStartEnd,
  normalizeTimestampMs,
  processTransactions,
  extractCurrentPrice,
  processBlockData
} = require('../../../workers/lib/server/handlers/finance.utils')

// ==================== validateStartEnd ====================

test('validateStartEnd - valid params', (t) => {
  const req = { query: { start: 1700000000000, end: 1700100000000 } }
  const { start, end } = validateStartEnd(req)
  t.is(start, 1700000000000, 'should return start')
  t.is(end, 1700100000000, 'should return end')
  t.pass()
})

test('validateStartEnd - missing start throws', (t) => {
  const req = { query: { end: 1700100000000 } }
  try {
    validateStartEnd(req)
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_START_END')
  }
  t.pass()
})

test('validateStartEnd - missing end throws', (t) => {
  const req = { query: { start: 1700000000000 } }
  try {
    validateStartEnd(req)
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_START_END')
  }
  t.pass()
})

test('validateStartEnd - invalid range throws', (t) => {
  const req = { query: { start: 1700100000000, end: 1700000000000 } }
  try {
    validateStartEnd(req)
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_INVALID_DATE_RANGE')
  }
  t.pass()
})

// ==================== resolveTimezone ====================

test('resolveTimezone - request timezone wins', (t) => {
  const ctx = { conf: { featureConfig: { lockedTimezone: 'America/Campo_Grande' } } }
  const req = { query: { timezone: 'Asia/Kolkata' } }
  t.is(resolveTimezone(ctx, req), 'Asia/Kolkata')
  t.pass()
})

test('resolveTimezone - falls back to common.json lockedTimezone', (t) => {
  const ctx = { conf: { featureConfig: { lockedTimezone: 'America/Campo_Grande' } } }
  const req = { query: {} }
  t.is(resolveTimezone(ctx, req), 'America/Campo_Grande')
  t.pass()
})

test('resolveTimezone - falls back to the constants default when unset anywhere', (t) => {
  const ctx = { conf: {} }
  const req = { query: {} }
  t.is(resolveTimezone(ctx, req), LOCKED_TIMEZONE_DEFAULT)
  t.pass()
})

test('resolveTimezone - rejects an invalid IANA timezone', (t) => {
  const ctx = { conf: {} }
  const req = { query: { timezone: 'Not/A_Zone' } }
  try {
    resolveTimezone(ctx, req)
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_INVALID_TIMEZONE')
  }
  t.pass()
})

// ==================== resolveStartEnd ====================

test('resolveStartEnd - never reinterprets start/end, even with an explicit request timezone', (t) => {
  const ctx = { conf: {} }
  const start = Date.UTC(2026, 5, 1, 0, 0, 0)
  const end = Date.UTC(2026, 5, 2, 0, 0, 0)
  const req = { query: { start, end, timezone: 'America/Campo_Grande' } }

  const result = resolveStartEnd(ctx, req)
  t.is(result.timezone, 'America/Campo_Grande')
  t.is(result.start, start, 'start is a true UTC instant, same as export')
  t.is(result.end, end, 'end is a true UTC instant, same as export')
  t.pass()
})

test('resolveStartEnd - resolves lockedTimezone but never shifts start/end', (t) => {
  const ctx = { conf: { featureConfig: { lockedTimezone: 'America/Campo_Grande' } } }
  const start = Date.UTC(2026, 5, 1, 0, 0, 0)
  const end = Date.UTC(2026, 5, 2, 0, 0, 0)
  const req = { query: { start, end } }

  const result = resolveStartEnd(ctx, req)
  t.is(result.timezone, 'America/Campo_Grande')
  t.is(result.start, start)
  t.is(result.end, end)
  t.pass()
})

test('resolveStartEnd - still validates start/end', (t) => {
  const ctx = { conf: {} }
  const req = { query: { start: 1700100000000, end: 1700000000000 } }
  try {
    resolveStartEnd(ctx, req)
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_INVALID_DATE_RANGE')
  }
  t.pass()
})

// ==================== normalizeTimestampMs ====================

test('normalizeTimestampMs - falsy input returns 0', (t) => {
  t.is(normalizeTimestampMs(0), 0)
  t.is(normalizeTimestampMs(null), 0)
  t.is(normalizeTimestampMs(undefined), 0)
  t.pass()
})

test('normalizeTimestampMs - seconds to ms conversion', (t) => {
  const ts = normalizeTimestampMs(1700006400)
  t.is(ts, 1700006400000, 'should multiply by 1000')
  t.pass()
})

test('normalizeTimestampMs - ms passthrough', (t) => {
  const ts = normalizeTimestampMs(1700006400000)
  t.is(ts, 1700006400000, 'should leave ms unchanged')
  t.pass()
})

test('normalizeTimestampMs - Ocean ISO-8601 string without a timezone is read as UTC', (t) => {
  t.is(normalizeTimestampMs('2026-05-28T16:46:30'), Date.UTC(2026, 4, 28, 16, 46, 30))
  t.pass()
})

test('normalizeTimestampMs - ISO-8601 string with an explicit zone keeps that zone', (t) => {
  t.is(normalizeTimestampMs('2026-05-28T16:46:30Z'), Date.UTC(2026, 4, 28, 16, 46, 30))
  t.is(normalizeTimestampMs('2026-05-28T16:46:30+02:00'), Date.UTC(2026, 4, 28, 14, 46, 30))
  t.pass()
})

test('normalizeTimestampMs - numeric strings normalize like numbers', (t) => {
  t.is(normalizeTimestampMs('1700006400'), 1700006400000, 'seconds as a string')
  t.is(normalizeTimestampMs('1700006400000'), 1700006400000, 'ms as a string')
  t.pass()
})

test('normalizeTimestampMs - unparseable input returns 0 rather than NaN', (t) => {
  t.is(normalizeTimestampMs('not-a-date'), 0)
  t.is(normalizeTimestampMs(NaN), 0)
  t.is(normalizeTimestampMs(Infinity), 0)
  t.is(normalizeTimestampMs({}), 0)
  t.pass()
})

// ==================== processTransactions ====================

test('processTransactions - Ocean earnings dated by ISO string are not dropped', (t) => {
  const results = [
    [{
      ts: 1779926400000,
      transactions: [
        { ts: '2026-05-28T16:46:30', satoshis_net_earned: 2632155, fees_colected_satoshis: 27238 }
      ]
    }]
  ]

  const { daily } = processTransactions(results, { trackFees: true }, 'UTC')
  const day = daily[Date.UTC(2026, 4, 28)]
  t.ok(day, 'the ISO-dated earning lands on its own UTC day')
  t.is(day.revenueBTC, 2632155 / 1e8)
  t.is(day.feesBTC, 27238 / 1e8)
  t.pass()
})

test('processTransactions - mixed f2pool and Ocean racks both contribute', (t) => {
  const results = [
    [{ transactions: [{ created_at: 1785621600, changed_balance: 0.0001, mining_extra: { tx_fee: 0.000001 } }] }],
    [{ transactions: [{ ts: '2026-05-28T16:46:30', satoshis_net_earned: 100000000 }] }]
  ]

  const { daily } = processTransactions(results, { trackFees: true }, 'UTC')
  const total = Object.values(daily).reduce((sum, d) => sum + d.revenueBTC, 0)
  t.is(Object.keys(daily).length, 2, 'one day per pool')
  t.is(total, 1.0001, 'both pools counted')
  t.pass()
})

test('processTransactions - Ocean data (sats)', (t) => {
  const results = [
    [{ transactions: [{ ts: 1700006400000, satoshis_net_earned: 50000000 }] }]
  ]
  const { daily } = processTransactions(results, {}, 'UTC')
  const key = Object.keys(daily)[0]
  t.is(daily[key].revenueBTC, 0.5, 'should convert sats to BTC')
  t.is(daily[key].feesBTC, undefined, 'should not track fees by default')
  t.pass()
})

test('processTransactions - F2Pool data (BTC)', (t) => {
  const results = [
    [{ transactions: [{ created_at: 1700006400, changed_balance: 0.001 }] }]
  ]
  const { daily } = processTransactions(results, {}, 'UTC')
  const key = Object.keys(daily)[0]
  t.is(daily[key].revenueBTC, 0.001, 'should use changed_balance directly as BTC')
  t.pass()
})

test('processTransactions - with trackFees (Ocean data)', (t) => {
  const results = [
    [{
      transactions: [{
        ts: 1700006400000,
        satoshis_net_earned: 50000000,
        fees_colected_satoshis: 1000000
      }]
    }]
  ]
  const { daily } = processTransactions(results, { trackFees: true }, 'UTC')
  const key = Object.keys(daily)[0]
  t.is(daily[key].revenueBTC, 0.5, 'should convert sats to BTC')
  t.is(daily[key].feesBTC, 0.01, 'should track fees in BTC')
  t.pass()
})

test('processTransactions - with trackFees (F2Pool data)', (t) => {
  const results = [
    [{
      transactions: [{
        created_at: 1700006400,
        changed_balance: 0.001,
        mining_extra: { tx_fee: 0.0001 }
      }]
    }]
  ]
  const { daily } = processTransactions(results, { trackFees: true }, 'UTC')
  const key = Object.keys(daily)[0]
  t.is(daily[key].revenueBTC, 0.001, 'should use changed_balance directly')
  t.is(daily[key].feesBTC, 0.0001, 'should extract tx_fee')
  t.pass()
})

test('processTransactions - seconds timestamps normalized', (t) => {
  const results = [
    [{ transactions: [{ ts: 1700006400, changed_balance: 0.001 }] }]
  ]
  const { daily } = processTransactions(results, {}, 'UTC')
  t.ok(Object.keys(daily).length > 0, 'should have entries from seconds timestamps')
  t.pass()
})

test('processTransactions - error results skipped', (t) => {
  const results = [{ error: 'timeout' }]
  const { daily } = processTransactions(results, {}, 'UTC')
  t.is(Object.keys(daily).length, 0, 'should be empty for error results')
  t.pass()
})

test('processTransactions - null entries skipped', (t) => {
  const results = [
    [{ transactions: [null, undefined] }]
  ]
  const { daily } = processTransactions(results, {}, 'UTC')
  t.is(Object.keys(daily).length, 0, 'should be empty for null entries')
  t.pass()
})

test('processTransactions - empty results', (t) => {
  const { daily } = processTransactions([], {}, 'UTC')
  t.is(Object.keys(daily).length, 0, 'should be empty')
  t.pass()
})

// ==================== extractCurrentPrice ====================

test('extractCurrentPrice - flat entry format (currentPrice)', (t) => {
  const results = [
    [{ currentPrice: 42000, blockHeight: 900000 }]
  ]
  t.is(extractCurrentPrice(results), 42000, 'should extract currentPrice')
  t.pass()
})

test('extractCurrentPrice - flat entry format (priceUSD)', (t) => {
  const results = [
    [{ priceUSD: 42000 }]
  ]
  t.is(extractCurrentPrice(results), 42000, 'should extract priceUSD')
  t.pass()
})

test('extractCurrentPrice - nested EBITDA format (numeric)', (t) => {
  const results = [{ data: 42000 }]
  t.is(extractCurrentPrice(results), 42000, 'should extract numeric nested price')
  t.pass()
})

test('extractCurrentPrice - nested EBITDA format (object)', (t) => {
  const results = [{ data: { USD: 42000 } }]
  t.is(extractCurrentPrice(results), 42000, 'should extract USD from nested object')
  t.pass()
})

test('extractCurrentPrice - error results return 0', (t) => {
  const results = [{ error: 'timeout' }]
  t.is(extractCurrentPrice(results), 0, 'should return 0 for error results')
  t.pass()
})

// ==================== processBlockData ====================

test('processBlockData - array items', (t) => {
  const results = [
    [{
      blocks: [{
        ts: 1700006400000,
        blockReward: 6.25,
        blockTotalFees: 0.5,
        blockSize: 1500000
      }]
    }]
  ]
  const daily = processBlockData(results, 'UTC')
  const key = Object.keys(daily)[0]
  t.is(daily[key].blockReward, 6.25, 'should extract blockReward')
  t.is(daily[key].blockTotalFees, 0.5, 'should extract blockTotalFees')
  t.is(daily[key].blockSize, 1500000, 'should extract blockSize')
  t.pass()
})

test('processBlockData - flat per-ork items (production shape)', (t) => {
  const results = [
    [
      { ts: 1700006400000, blockSize: 1500000, blockHash: 'abc', blockReward: 6.25, blockTotalFees: 0.5 },
      { ts: 1700006400000, blockSize: 1200000, blockHash: 'def', blockReward: 6.25, blockTotalFees: 0.3 }
    ]
  ]
  const daily = processBlockData(results, 'UTC')
  const key = Object.keys(daily)[0]
  t.is(daily[key].blockReward, 12.5, 'should sum blockReward across same-day items')
  t.is(daily[key].blockTotalFees, 0.8, 'should sum blockTotalFees across same-day items')
  t.is(daily[key].blockSize, 2700000, 'should sum blockSize across same-day items')
  t.pass()
})

test('processBlockData - object-keyed items', (t) => {
  const results = [
    [{ data: { 1700006400000: { blockReward: 6.25, blockTotalFees: 0.5 } } }]
  ]
  const daily = processBlockData(results, 'UTC')
  const key = Object.keys(daily)[0]
  t.is(daily[key].blockReward, 6.25, 'should extract from object keys')
  t.is(daily[key].blockTotalFees, 0.5, 'should extract fees from object keys')
  t.pass()
})

test('processBlockData - alt field names', (t) => {
  const results = [
    [{
      blocks: [{
        ts: 1700006400000,
        block_reward: 6.25,
        total_fees: 0.5
      }]
    }]
  ]
  const daily = processBlockData(results, 'UTC')
  const key = Object.keys(daily)[0]
  t.is(daily[key].blockReward, 6.25, 'should handle snake_case field')
  t.is(daily[key].blockTotalFees, 0.5, 'should handle total_fees field')
  t.pass()
})

test('processBlockData - error/empty results', (t) => {
  t.is(Object.keys(processBlockData([{ error: 'timeout' }], 'UTC')).length, 0, 'error results empty')
  t.is(Object.keys(processBlockData([], 'UTC')).length, 0, 'empty results empty')
  t.pass()
})

test('processTransactions buckets f2pool payouts by mining_extra.mining_date when present', (t) => {
  const { processTransactions } = require('../../../workers/lib/server/handlers/finance.utils')
  const miningDay = 1700006400000
  const settleDay = miningDay + 86400000
  const { daily } = processTransactions([[{ transactions: [{ created_at: settleDay / 1000, changed_balance: 1, mining_extra: { mining_date: miningDay / 1000 } }] }]], {}, 'UTC')
  t.alike(Object.keys(daily), [String(miningDay)])
})

test('processTransactions drops transactions whose mining date is outside start/end', (t) => {
  const day = 1700006400000
  const DAY = 86400000
  const tx = (miningMs) => ({ created_at: (day + DAY) / 1000, changed_balance: 1, mining_extra: { mining_date: miningMs / 1000 } })
  const { daily } = processTransactions([[{ transactions: [tx(day - DAY), tx(day), tx(day + DAY)] }]], { start: day, end: day + DAY - 1 }, 'UTC')
  t.alike(Object.keys(daily), [String(day)], 'the day before start and the day after end are dropped')
})

// ==================== priceDailyRevenue ====================

const {
  priceBucket,
  priceDailyRevenue,
  pricingStatus,
  fetchBucketPrices
} = require('../../../workers/lib/server/handlers/finance.utils')

// Stands in for the mempool worker's bucket cache. `seed` maps bucket ts -> price.
const ctxWithPrices = (seed = {}, onQuery = () => {}) => ({
  dataProxy: {
    async requestData (_method, params) {
      onQuery(params.query)
      const prices = {}
      for (const ts of params.query.timestamps) {
        if (seed[ts]) prices[ts] = seed[ts]
      }
      return [{ prices, missing: params.query.timestamps.filter((ts) => !seed[ts]) }]
    }
  }
})

const DAY = 1700006400000
const MORNING = DAY + 30 * 60 * 1000
const EVENING = DAY + 22 * 60 * 60 * 1000

test('priceDailyRevenue values each payout at the price of the bucket it landed in', async (t) => {
  const ctx = ctxWithPrices({
    [priceBucket(MORNING)]: 30000,
    [priceBucket(EVENING)]: 40000
  })

  const { daily, missingPriceBuckets } = await priceDailyRevenue(ctx, {
    txEntries: [
      { ts: MORNING, amountBTC: 1, feeBTC: 0 },
      { ts: EVENING, amountBTC: 1, feeBTC: 0 }
    ],
    dailyPrices: { [DAY]: 99999 }
  })

  t.is(daily[DAY].revenueUSD, 70000, 'each payout priced at its own moment, not one daily price')
  t.is(daily[DAY].revenueBTC, 2)
  t.is(daily[DAY].btcPrice, 35000, 'reported price is the blend the revenue actually realised')
  t.is(daily[DAY].unpricedPayouts, 0)
  t.is(missingPriceBuckets, 0)
})

test('priceDailyRevenue falls back to the daily price and counts the shortfall', async (t) => {
  const ctx = ctxWithPrices({ [priceBucket(MORNING)]: 30000 })

  const { daily, missingPriceBuckets } = await priceDailyRevenue(ctx, {
    txEntries: [
      { ts: MORNING, amountBTC: 1, feeBTC: 0 },
      { ts: EVENING, amountBTC: 1, feeBTC: 0 }
    ],
    dailyPrices: { [DAY]: 50000 }
  })

  t.is(daily[DAY].revenueUSD, 80000, 'the unpriced payout keeps the old daily-price behaviour')
  t.is(daily[DAY].unpricedPayouts, 1, 'and the fallback is reported rather than silent')
  t.is(missingPriceBuckets, 1)
})

test('priceDailyRevenue falls back to the current price when the day has none either', async (t) => {
  const ctx = ctxWithPrices()

  const { daily } = await priceDailyRevenue(ctx, {
    txEntries: [{ ts: MORNING, amountBTC: 2, feeBTC: 0 }],
    currentBtcPrice: 10000
  })

  t.is(daily[DAY].revenueUSD, 20000)
  t.is(daily[DAY].unpricedPayouts, 1)
})

test('priceDailyRevenue keeps the payout/rebate split and prices rebates too', async (t) => {
  const ctx = ctxWithPrices({ [priceBucket(MORNING)]: 30000, [priceBucket(EVENING)]: 30000 })

  const { daily } = await priceDailyRevenue(ctx, {
    txEntries: [{ ts: MORNING, amountBTC: 1, feeBTC: 0 }],
    rebates: [{ ts: EVENING, amountBTC: 0.5 }]
  })

  t.is(daily[DAY].revenueBTC, 1.5)
  t.is(daily[DAY].payoutBTC, 1)
  t.is(daily[DAY].rebateBTC, 0.5)
  t.is(daily[DAY].revenueUSD, 45000)
})

test('priceDailyRevenue uses a rebate price captured at receipt without a lookup', async (t) => {
  const asked = []
  const ctx = ctxWithPrices({}, (query) => asked.push(...query.timestamps))

  const { daily, missingPriceBuckets } = await priceDailyRevenue(ctx, {
    rebates: [{ ts: EVENING, amountBTC: 2, priceUSD: 25000 }],
    dailyPrices: { [DAY]: 99999 }
  })

  t.is(daily[DAY].revenueUSD, 50000, 'the stored receipt price wins over the daily price')
  t.is(daily[DAY].unpricedPayouts, 0)
  t.is(missingPriceBuckets, 0)
  t.alike(asked, [], 'a rebate priced at receipt needs no bucket lookup at all')
})

test('priceDailyRevenue prices fees per payout when tracking them', async (t) => {
  const ctx = ctxWithPrices({ [priceBucket(MORNING)]: 30000, [priceBucket(EVENING)]: 40000 })

  const { daily } = await priceDailyRevenue(ctx, {
    txEntries: [
      { ts: MORNING, amountBTC: 1, feeBTC: 0.1 },
      { ts: EVENING, amountBTC: 1, feeBTC: 0.1 }
    ],
    trackFees: true
  })

  t.is(daily[DAY].feesBTC, 0.2)
  t.is(daily[DAY].feesUSD, 7000, 'fees follow the same per-payout price as revenue')
})

test('priceDailyRevenue asks for each bucket once however many payouts share it', async (t) => {
  const queries = []
  const ctx = ctxWithPrices({ [priceBucket(MORNING)]: 30000 }, (q) => queries.push(q.timestamps))

  await priceDailyRevenue(ctx, {
    txEntries: [
      { ts: MORNING, amountBTC: 1, feeBTC: 0 },
      { ts: MORNING + 1000, amountBTC: 1, feeBTC: 0 },
      { ts: MORNING + 60000, amountBTC: 1, feeBTC: 0 }
    ]
  })

  t.is(queries.length, 1, 'one request per finance call, not one per payout')
  t.alike(queries[0], [priceBucket(MORNING)])
})

test('priceDailyRevenue degrades to daily pricing when the price worker errors', async (t) => {
  const ctx = {
    dataProxy: { requestData: async () => [{ error: 'CHANNEL_CLOSED' }] }
  }

  const { daily } = await priceDailyRevenue(ctx, {
    txEntries: [{ ts: MORNING, amountBTC: 1, feeBTC: 0 }],
    dailyPrices: { [DAY]: 50000 }
  })

  t.is(daily[DAY].revenueUSD, 50000, 'an unreachable price worker never breaks the response')
  t.is(daily[DAY].unpricedPayouts, 1)
})

test('priceDailyRevenue degrades the same way when every ork is down and the RPC throws', async (t) => {
  // requestData propagates the first error when no ork answered at all - a
  // total outage must not 500 a finance endpoint that used to succeed.
  const ctx = {
    dataProxy: { requestData: async () => { throw new Error('CHANNEL_CLOSED') } }
  }

  const { daily, missingPriceBuckets } = await priceDailyRevenue(ctx, {
    txEntries: [{ ts: MORNING, amountBTC: 1, feeBTC: 0 }],
    dailyPrices: { [DAY]: 50000 }
  })

  t.is(daily[DAY].revenueUSD, 50000)
  t.is(daily[DAY].unpricedPayouts, 1)
  t.is(missingPriceBuckets, 1)
})

test('priceDailyRevenue splits payouts across their own local days', async (t) => {
  const nextDay = DAY + 86400000
  const ctx = ctxWithPrices({ [priceBucket(MORNING)]: 30000, [priceBucket(nextDay)]: 40000 })

  const { daily } = await priceDailyRevenue(ctx, {
    txEntries: [
      { ts: MORNING, amountBTC: 1, feeBTC: 0 },
      { ts: nextDay, amountBTC: 1, feeBTC: 0 }
    ]
  })

  t.is(daily[DAY].revenueUSD, 30000)
  t.is(daily[nextDay].revenueUSD, 40000)
})

test('priceDailyRevenue skips malformed rebates', async (t) => {
  const ctx = ctxWithPrices({ [priceBucket(MORNING)]: 30000 })

  const { daily } = await priceDailyRevenue(ctx, {
    txEntries: [{ ts: MORNING, amountBTC: 1, feeBTC: 0 }],
    rebates: [null, { ts: 'x', amountBTC: 1 }, { ts: MORNING, amountBTC: null }]
  })

  t.is(daily[DAY].revenueBTC, 1, 'only the real payout counts')
  t.is(daily[DAY].rebateBTC, 0)
})

test('pricingStatus reports completeness from the missing bucket count', (t) => {
  t.alike(pricingStatus(0), { missingPriceBuckets: 0, pricingComplete: true })
  t.alike(pricingStatus(3), { missingPriceBuckets: 3, pricingComplete: false })
})

test('fetchBucketPrices unwraps the nesting the ork actually replies with', async (t) => {
  const bucket = priceBucket(MORNING)

  // One entry per ork; each ork concatenates its racks' object replies into an
  // array. A rack with no mempool worker contributes an empty array.
  const ctx = {
    dataProxy: {
      requestData: async () => [
        [],
        [{ prices: { [bucket]: 30000 }, missing: [] }],
        { error: 'CHANNEL_CLOSED' }
      ]
    }
  }

  t.alike(await fetchBucketPrices(ctx, [bucket]), { [bucket]: 30000 })
})

test('fetchBucketPrices merges price maps from several racks', async (t) => {
  const a = priceBucket(MORNING)
  const b = priceBucket(EVENING)

  const ctx = {
    dataProxy: {
      requestData: async () => [[{ prices: { [a]: 1 } }, { prices: { [b]: 2 } }]]
    }
  }

  t.alike(await fetchBucketPrices(ctx, [a, b]), { [a]: 1, [b]: 2 })
})

test('fetchBucketPrices asks nothing when there is nothing to price', async (t) => {
  let called = false
  const ctx = { dataProxy: { requestData: async () => { called = true; return [] } } }

  t.alike(await fetchBucketPrices(ctx, []), {})
  t.absent(called, 'no payouts means no RPC at all')
})

test('priceDailyRevenue ignores zero-value payouts when judging pricing completeness', async (t) => {
  const asked = []
  const ctx = ctxWithPrices({ [priceBucket(MORNING)]: 30000 }, (q) => asked.push(...q.timestamps))

  const { daily, missingPriceBuckets } = await priceDailyRevenue(ctx, {
    txEntries: [
      { ts: MORNING, amountBTC: 1, feeBTC: 0 },
      // A transaction that nets to nothing - must not cost a lookup nor
      // flag the range as unpriced.
      { ts: EVENING, amountBTC: 0, feeBTC: 0 }
    ]
  })

  t.alike(asked, [priceBucket(MORNING)], 'the worthless payout requests no bucket')
  t.is(daily[DAY].unpricedPayouts, 0)
  t.is(missingPriceBuckets, 0)
  t.is(daily[DAY].revenueBTC, 1)
})

test('priceDailyRevenue caps the bucket request on pathological ranges', async (t) => {
  const PRICE_BUCKET_MS = 5 * 60 * 1000
  const queries = []
  const ctx = ctxWithPrices({}, (q) => queries.push(q.timestamps))

  const txEntries = Array.from({ length: 5001 }, (_, i) => ({
    ts: DAY + i * PRICE_BUCKET_MS,
    amountBTC: 0.001,
    feeBTC: 0
  }))

  const { missingPriceBuckets } = await priceDailyRevenue(ctx, { txEntries })

  t.is(queries.length, 1)
  t.is(queries[0].length, 5000, 'the RPC payload is bounded')
  t.is(queries[0][0], priceBucket(DAY + 5000 * PRICE_BUCKET_MS), 'newest buckets win the slots')
  t.is(missingPriceBuckets, 5001, 'everything unresolved is still reported honestly')
})
