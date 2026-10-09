'use strict'

const test = require('brittle')
const {
  getEnergyBalance,
  getCostParameters,
  resolveLcoeUsdPerMwh,
  resolveCostParametersForMonth,
  resolveEnergyCostsUSD,
  processPriceData,
  processCostsData,
  calculateSummary,
  getEbitda,
  processEbitdaPrices,
  calculateEbitdaSummary,
  getCostSummary,
  calculateCostSummary,
  getSubsidyFees,
  calculateSubsidyFeesSummary,
  getRevenue,
  getRevenueHourly,
  processHourlyRevenues,
  calculateRevenueSummary,
  getRevenueSummary,
  calculateDetailedRevenueSummary,
  getHashRevenue,
  getPowerCost,
  getProductionCosts,
  processDailyRevenueBtc,
  processDailyAvgPrices,
  processNetworkHashrateData,
  calculateHashRevenueSummary,
  getDailySeries,
  sumCostsByMonth,
  localMonthStart
} = require('../../../workers/lib/server/handlers/finance.handlers')
const { getConsumption } = require('../../../workers/lib/server/handlers/metrics.handlers')
const { priceBucket } = require('../../../workers/lib/server/handlers/finance.utils')
const { withDataProxy } = require('../helpers/mockHelpers')

// ==================== Energy Balance Tests ====================

test('getEnergyBalance - happy path', async (t) => {
  const dayTs = 1700006400000
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }]
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'tailLog') {
          return [{ ts: dayTs, site_power_w: 5000 }]
        }
        if (method === 'getWrkExtData') {
          if (payload.query && payload.query.key === 'transactions') {
            return [{ ts: dayTs, transactions: [{ ts: dayTs, changed_balance: 0.5 }] }]
          }
          if (payload.query && payload.query.key === 'HISTORICAL_PRICES') {
            return [{ ts: dayTs, priceUSD: 40000 }]
          }
          if (payload.query && payload.query.key === 'current_price') {
            return [{ currentPrice: 40000 }]
          }
          if (payload.query && payload.query.key === 'stats-history') {
            return []
          }
        }
        if (method === 'getGlobalConfig') {
          return { nominalPowerAvailability_MW: 10 }
        }
        return {}
      }
    },
    globalDataLib: {
      getGlobalData: async () => []
    }
  })

  const mockReq = {
    query: { start: 1700000000000, end: 1700100000000, period: 'daily' }
  }

  const result = await getEnergyBalance(mockCtx, mockReq, {})
  t.ok(result.log, 'should return log array')
  t.ok(result.summary, 'should return summary')
  t.ok(Array.isArray(result.log), 'log should be array')
  t.pass()
})

test('getEnergyBalance - missing start throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [], site: 'test-site' },
    net_r0: { jRequest: async () => ({}) },
    globalDataLib: { getGlobalData: async () => [] }
  })

  const mockReq = { query: { end: 1700100000000 } }

  try {
    await getEnergyBalance(mockCtx, mockReq, {})
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_START_END', 'should throw missing start/end error')
  }
  t.pass()
})

test('getEnergyBalance - missing end throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [], site: 'test-site' },
    net_r0: { jRequest: async () => ({}) },
    globalDataLib: { getGlobalData: async () => [] }
  })

  const mockReq = { query: { start: 1700000000000 } }

  try {
    await getEnergyBalance(mockCtx, mockReq, {})
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_START_END', 'should throw missing start/end error')
  }
  t.pass()
})

test('getEnergyBalance - invalid range throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [], site: 'test-site' },
    net_r0: { jRequest: async () => ({}) },
    globalDataLib: { getGlobalData: async () => [] }
  })

  const mockReq = { query: { start: 1700100000000, end: 1700000000000 } }

  try {
    await getEnergyBalance(mockCtx, mockReq, {})
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_INVALID_DATE_RANGE', 'should throw invalid range error')
  }
  t.pass()
})

test('getEnergyBalance - empty ork results', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }]
    },
    net_r0: {
      jRequest: async () => ({})
    },
    globalDataBee: {
      sub: () => ({
        sub: () => ({
          createReadStream: () => (async function * () {})()
        })
      })
    }
  })

  const mockReq = {
    query: { start: 1700000000000, end: 1700100000000, period: 'daily' }
  }

  const result = await getEnergyBalance(mockCtx, mockReq, {})
  t.ok(result.log, 'should return log array')
  t.ok(result.summary, 'should return summary')
  t.is(result.log.length, 0, 'log should be empty with no data')
  t.pass()
})

test('processPriceData - processes mempool price data', (t) => {
  const results = [
    [{ ts: 1700006400000, priceUSD: 40000 }]
  ]

  const daily = processPriceData(results, 'UTC')
  t.ok(typeof daily === 'object', 'should return object')
  t.ok(Object.keys(daily).length > 0, 'should have entries')
  const key = Object.keys(daily)[0]
  t.is(daily[key], 40000, 'should extract priceUSD')
  t.pass()
})

test('processCostsData - processes dashboard format (energyCostsUSD)', (t) => {
  const costs = [
    { region: 'site1', year: 2023, month: 11, energyCostsUSD: 30000, operationalCostsUSD: 6000 }
  ]

  const result = processCostsData(costs)
  t.ok(result['2023-11'], 'should have month key')
  t.is(result['2023-11'].energyCostPerDay, 1000, 'should have daily energy cost (30000/30)')
  t.is(result['2023-11'].operationalCostPerDay, 200, 'should have daily operational cost (6000/30)')
  t.pass()
})

test('processCostsData - processes app-node format (energyCost)', (t) => {
  const costs = [
    { site: 'site1', year: 2023, month: 11, energyCost: 30000, operationalCost: 6000 }
  ]

  const result = processCostsData(costs)
  t.ok(result['2023-11'], 'should have month key')
  t.is(result['2023-11'].energyCostPerDay, 1000, 'should have daily energy cost (30000/30)')
  t.is(result['2023-11'].operationalCostPerDay, 200, 'should have daily operational cost (6000/30)')
  t.pass()
})

test('processCostsData - handles non-array input', (t) => {
  const result = processCostsData(null)
  t.ok(typeof result === 'object', 'should return object')
  t.is(Object.keys(result).length, 0, 'should be empty')
  t.pass()
})

test('calculateSummary - calculates from log entries', (t) => {
  const log = [
    { revenueBTC: 0.5, revenueUSD: 20000, energyCostUSD: 4000, totalCostUSD: 5000, profitUSD: 15000, consumptionMWh: 100, sitePowerMW: 4 },
    { revenueBTC: 0.3, revenueUSD: 12000, energyCostUSD: 2400, totalCostUSD: 3000, profitUSD: 9000, consumptionMWh: 60, sitePowerMW: 2 }
  ]

  const summary = calculateSummary(log)
  t.is(summary.totalRevenueBTC, 0.8, 'should sum BTC revenue')
  t.is(summary.totalRevenueUSD, 32000, 'should sum USD revenue')
  t.is(summary.totalCostUSD, 8000, 'should sum costs')
  t.is(summary.totalProfitUSD, 24000, 'should sum profit')
  t.is(summary.totalConsumptionMWh, 160, 'should sum consumption')
  t.is(summary.avgPowerConsumption, 3, 'avgPowerConsumption averages sitePowerMW (4+2)/2')
  t.ok(summary.avgCostPerMWh !== null, 'should calculate avg cost per MWh')
  t.ok(summary.avgEnergyCostPerMWh !== null, 'should calculate avg energy cost per MWh')
  t.ok(summary.avgOperationalCostPerMWh !== null, 'should calculate avg operational cost per MWh')
  t.ok(summary.avgRevenuePerMWh !== null, 'should calculate avg revenue per MWh')
  t.pass()
})

test('calculateSummary - handles empty log', (t) => {
  const summary = calculateSummary([])
  t.is(summary.totalRevenueBTC, 0, 'should be zero')
  t.is(summary.totalRevenueUSD, 0, 'should be zero')
  t.is(summary.avgCostPerMWh, null, 'should be null')
  t.pass()
})

// ==================== getDailySeries Tests ====================

test('getDailySeries - requests the hourly interval and rolls up by the local calendar day', async (t) => {
  let capturedKey = null
  // 02:00 UTC on Sep 1 is 22:00 on Aug 31 in America/Campo_Grande (UTC-4) - still the
  // previous LOCAL day, even though it's the same UTC calendar day as the other sample.
  const sampleAugUtc = Date.UTC(2026, 8, 1, 2)
  const sampleSepUtc = Date.UTC(2026, 8, 1, 6)

  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'tailLog') {
          capturedKey = payload.key
          return [
            { ts: sampleAugUtc, site_power_w: 1000000 },
            { ts: sampleSepUtc, site_power_w: 3000000 }
          ]
        }
        return []
      }
    }
  })

  const byDay = await getDailySeries(
    mockCtx,
    Date.UTC(2026, 7, 31),
    Date.UTC(2026, 8, 2),
    getConsumption,
    'powerW',
    'America/Campo_Grande'
  )

  t.is(capturedKey, 'stat-30m', 'requests the 30m-backed hourly source, not the 3h daily one')

  const aug31Local = Date.UTC(2026, 7, 31, 4) // Campo_Grande midnight Aug 31 = 04:00 UTC
  const sep1Local = Date.UTC(2026, 8, 1, 4) // Campo_Grande midnight Sep 1 = 04:00 UTC
  t.is(byDay[aug31Local], 1000000, '02:00 UTC sample lands on local Aug 31, not UTC Sep 1')
  t.is(byDay[sep1Local], 3000000, '06:00 UTC sample lands on local Sep 1')
  t.pass()
})

test('getDailySeries - caches a completed month on ctx and does not refetch it', async (t) => {
  let tailLogCalls = 0
  const ts = Date.UTC(2024, 0, 15, 12)
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method) => {
        if (method === 'tailLog') {
          tailLogCalls++
          return [{ ts, site_power_w: 2000000 }]
        }
        return []
      }
    }
  })

  const start = Date.UTC(2024, 0, 1)
  const end = Date.UTC(2024, 1, 1)
  const first = await getDailySeries(mockCtx, start, end, getConsumption, 'powerW', 'UTC')
  const second = await getDailySeries(mockCtx, start, end, getConsumption, 'powerW', 'UTC')

  t.is(tailLogCalls, 1, 'the second call for the same completed month is served from cache')
  t.alike(first, second, 'cached result matches the freshly-fetched one')
  t.pass()
})

test('getDailySeries - refresh skips the cached month and stores the fresh rollup', async (t) => {
  let tailLogCalls = 0
  let powerW = 2000000
  const ts = Date.UTC(2024, 0, 15, 12)
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method) => {
        if (method === 'tailLog') {
          tailLogCalls++
          return [{ ts, site_power_w: powerW }]
        }
        return []
      }
    }
  })

  const start = Date.UTC(2024, 0, 1)
  const end = Date.UTC(2024, 1, 1)
  const dayTs = Date.UTC(2024, 0, 15)
  await getDailySeries(mockCtx, start, end, getConsumption, 'powerW', 'UTC')
  powerW = 3000000 // a backfill lands after the month was cached
  const refreshed = await getDailySeries(mockCtx, start, end, getConsumption, 'powerW', 'UTC', true)
  const after = await getDailySeries(mockCtx, start, end, getConsumption, 'powerW', 'UTC')

  t.is(tailLogCalls, 2, 'refresh refetches; the call after it is served from cache')
  t.is(refreshed[dayTs], 3000000, 'refresh returns the backfilled value, not the cached one')
  t.is(after[dayTs], 3000000, 'and the cache now holds the fresh rollup')
  t.pass()
})

// Hourly power for every hour of Jan 2024, served from a plain handler so the tests see
// exactly what getDailySeries asked for.
function hourlyJanuaryHandler () {
  const log = []
  for (let ts = Date.UTC(2024, 0, 1); ts < Date.UTC(2024, 1, 1); ts += 3600000) log.push({ ts, powerW: 1 })
  return async (ctx, req) => ({ log: log.filter(e => e.ts >= req.query.start && e.ts <= req.query.end) })
}

test('getDailySeries - a partially covered month is not cached as the whole month', async (t) => {
  const ctx = {}
  const handler = hourlyJanuaryHandler()
  const DAY = 86400000
  const jan1 = Date.UTC(2024, 0, 1)

  await getDailySeries(ctx, jan1 + 9 * DAY, jan1 + 20 * DAY - 1, handler, 'powerW', 'UTC')
  const full = await getDailySeries(ctx, jan1, Date.UTC(2024, 1, 1) - 1, handler, 'powerW', 'UTC')

  t.is(Object.keys(full).length, 31, 'the full month is fetched, not answered with the earlier 11-day slice')
})

test('getDailySeries - a cached whole month is clamped to the requested days', async (t) => {
  const ctx = {}
  const handler = hourlyJanuaryHandler()
  const DAY = 86400000
  const jan1 = Date.UTC(2024, 0, 1)

  await getDailySeries(ctx, jan1, Date.UTC(2024, 1, 1) - 1, handler, 'powerW', 'UTC')
  const partial = await getDailySeries(ctx, jan1 + 9 * DAY, jan1 + 20 * DAY - 1, handler, 'powerW', 'UTC')

  t.alike(Object.keys(partial).map(Number), Array.from({ length: 11 }, (_, i) => jan1 + (9 + i) * DAY),
    'only Jan 10-20, not the rest of the cached month')
})

test('getDailySeries - a different ctx gets its own cache (no cross-request leakage)', async (t) => {
  const ts = Date.UTC(2024, 0, 15, 12)
  const buildCtx = (powerW) => withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async (key, method) => (method === 'tailLog' ? [{ ts, site_power_w: powerW }] : []) }
  })

  const start = Date.UTC(2024, 0, 1)
  const end = Date.UTC(2024, 1, 1)
  const ctxA = await getDailySeries(buildCtx(1000000), start, end, getConsumption, 'powerW', 'UTC')
  const ctxB = await getDailySeries(buildCtx(9000000), start, end, getConsumption, 'powerW', 'UTC')

  t.not(Object.values(ctxA)[0], Object.values(ctxB)[0], 'a fresh ctx is not served the other ctx\'s cached data')
  t.pass()
})

// `statDays` defaults to `days`, i.e. every day the transactions cover also reported
// telemetry. Pass a shorter list to model a gap in the stat log: a day the site was paid
// for but never reported a hashrate sample.
function makeMockCtx (days, statDays = days) {
  return withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (_key, method, payload) => {
        if (method === 'tailLog') {
          return statDays.map(d => ({ ts: d.ts, site_power_w: d.powerW, hashrate_mhs_5m_sum_aggr: d.hashrateMhs || 0 }))
        }
        if (method === 'getWrkExtData') {
          if (payload.query && payload.query.key === 'transactions') {
            return days.map(d => ({ ts: d.ts, transactions: [{ ts: d.ts, changed_balance: d.btc }] }))
          }
          if (payload.query && payload.query.key === 'HISTORICAL_PRICES') {
            return days.map(d => ({ ts: d.ts, priceUSD: d.price }))
          }
          if (payload.query && payload.query.key === 'current_price') {
            return [{ currentPrice: days[0].price }]
          }
          if (payload.query && payload.query.key === 'stats-history') {
            return []
          }
        }
        if (method === 'getGlobalConfig') {
          return { nominalPowerAvailability_MW: 10 }
        }
        return {}
      }
    },
    globalDataLib: { getGlobalData: async () => [] }
  })
}

test('getEnergyBalance daily - per-day entries carry sitePowerMW and per-MW revenue', async (t) => {
  const day1 = Date.UTC(2024, 0, 15)
  const day2 = Date.UTC(2024, 0, 16)
  const days = [
    { ts: day1, powerW: 5_000_000, btc: 0.5, price: 40000 },
    { ts: day2, powerW: 3_000_000, btc: 0.3, price: 40000 }
  ]

  const result = await getEnergyBalance(makeMockCtx(days), {
    query: { start: day1 - 1000, end: day2 + 86400000, period: 'daily' }
  }, {})

  t.is(result.log.length, 2, 'one entry per day')
  for (const e of result.log) {
    t.ok(e.sitePowerMW > 0, 'sitePowerMW present')
    t.ok('energyRevenueBTC_MW' in e && 'energyRevenueUSD_MW' in e, 'per-MW revenue fields present')
  }
  t.is(result.log[0].sitePowerMW, 5, 'first day sitePowerMW = 5')
  t.is(result.log[1].sitePowerMW, 3, 'second day sitePowerMW = 3')
})

test('getEnergyBalance monthly - rates use MEAN, totals use SUM, per-MW is RECOMPUTED', async (t) => {
  const day1 = Date.UTC(2024, 0, 15)
  const day2 = Date.UTC(2024, 0, 16)
  const day3 = Date.UTC(2024, 0, 17)
  const days = [
    { ts: day1, powerW: 5_000_000, btc: 0.5, price: 40000 },
    { ts: day2, powerW: 3_000_000, btc: 0.3, price: 40000 },
    { ts: day3, powerW: 4_000_000, btc: 0.4, price: 40000 }
  ]

  const result = await getEnergyBalance(makeMockCtx(days), {
    query: { start: day1 - 1000, end: day3 + 86400000, period: 'monthly' }
  }, {})

  t.is(result.log.length, 1, 'three days collapse to one monthly bucket')
  const m = result.log[0]
  t.ok(Math.abs(m.revenueBTC - 1.2) < 1e-9, 'revenueBTC summed (~1.2)')
  t.ok(Math.abs(m.revenueUSD - 48000) < 1e-6, 'revenueUSD summed (~48000)')
  t.is(m.sitePowerMW, 4, 'sitePowerMW averaged: (5+3+4)/3')
  t.ok(Math.abs(m.energyRevenueUSD_MW - 12000) < 1e-6, 'per-MW recomputed from sum / mean, not summed daily values')
  t.ok(Math.abs(m.energyRevenueBTC_MW - 0.3) < 1e-9, 'BTC per-MW recomputed')
})

// A day holding several payouts at different times, with the mempool worker
// serving a price per 5-minute bucket. `bucketPrices` maps bucket ts -> price;
// anything absent models a bucket the server-side backfill has not reached yet.
function makeReceiptPricedCtx (dayTs, payouts, bucketPrices, dailyPrice) {
  return withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (_key, method, payload) => {
        if (method === 'tailLog') {
          return [{ ts: dayTs, site_power_w: 1_000_000, hashrate_mhs_5m_sum_aggr: 100 }]
        }
        if (method === 'getWrkExtData') {
          const key = payload.query && payload.query.key
          if (key === 'transactions') {
            return [{ ts: dayTs, transactions: payouts.map(p => ({ ts: p.ts, changed_balance: p.btc })) }]
          }
          if (key === 'HISTORICAL_PRICES') return [{ ts: dayTs, priceUSD: dailyPrice }]
          if (key === 'current_price') return [{ currentPrice: dailyPrice }]
          if (key === 'PRICE_AT_TIMESTAMPS') {
            const prices = {}
            for (const ts of payload.query.timestamps) {
              if (bucketPrices[ts]) prices[ts] = bucketPrices[ts]
            }
            // Array-wrapped, as the ork actually replies: it wraps each rack's
            // object reply and concatenates across racks.
            return [{ prices, missing: payload.query.timestamps.filter(ts => !bucketPrices[ts]) }]
          }
          if (key === 'stats-history') return []
        }
        if (method === 'getGlobalConfig') return { nominalPowerAvailability_MW: 10 }
        return {}
      }
    },
    globalDataLib: { getGlobalData: async () => [] }
  })
}

test('getRevenueSummary values same-day payouts at the price each one arrived at', async (t) => {
  const day = Date.UTC(2024, 0, 15)
  const morning = day + 30 * 60 * 1000
  const evening = day + 22 * 60 * 60 * 1000
  const payouts = [{ ts: morning, btc: 1 }, { ts: evening, btc: 1 }]
  const bucketPrices = {
    [priceBucket(morning)]: 30000,
    [priceBucket(evening)]: 50000
  }

  const result = await getRevenueSummary(
    makeReceiptPricedCtx(day, payouts, bucketPrices, 99999),
    { query: { start: day - 1000, end: day + 86400000, period: 'daily' } },
    {}
  )

  const entry = result.log[0]
  t.is(entry.revenueUSD, 80000, 'each payout valued at its own moment, not one daily price')
  t.is(entry.btcPrice, 40000, 'the reported price is the blend actually realised')
  t.is(entry.unpricedPayouts, 0)
  t.is(result.summary.pricingComplete, true)
  t.is(result.summary.missingPriceBuckets, 0)
})

test('getRevenueSummary flags the range when a payout had no recorded price', async (t) => {
  const day = Date.UTC(2024, 0, 15)
  const morning = day + 30 * 60 * 1000
  const evening = day + 22 * 60 * 60 * 1000
  const payouts = [{ ts: morning, btc: 1 }, { ts: evening, btc: 1 }]
  // Only the morning bucket was ever recorded.
  const bucketPrices = { [priceBucket(morning)]: 30000 }

  const result = await getRevenueSummary(
    makeReceiptPricedCtx(day, payouts, bucketPrices, 50000),
    { query: { start: day - 1000, end: day + 86400000, period: 'daily' } },
    {}
  )

  const entry = result.log[0]
  t.is(entry.revenueUSD, 80000, 'the unpriced payout keeps the previous daily-price behaviour')
  t.is(entry.unpricedPayouts, 1)
  t.is(result.summary.pricingComplete, false, 'the response says so rather than hiding the fallback')
  t.is(result.summary.missingPriceBuckets, 1)
})

test('getRevenueSummary - phase rows withhold the site-power ratios until consumption splits', async (t) => {
  // Unique month so the daily-series month cache cannot leak across tests.
  const dayTs = Date.UTC(2031, 5, 15)
  const ctx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }],
      featureConfig: {
        phases: [{
          id: 'phase1_5',
          label: 'Phase 1.5',
          minerTelemetry: false,
          consumption: { source: 'manual' },
          pool: { accounts: [{ poolType: 'ocean', username: 'acme-addr' }] }
        }]
      }
    },
    net_r0: {
      jRequest: async (_key, method, payload) => {
        if (method === 'tailLog') {
          return [{ ts: dayTs, site_power_w: 10_000_000, hashrate_mhs_5m_sum_aggr: 1e9 }]
        }
        if (method === 'getWrkExtData') {
          const key = payload.query && payload.query.key
          if (key === 'transactions') {
            return [{
              ts: dayTs,
              transactions: [
                { ts: dayTs, satoshis_net_earned: 100000000, username: 'site-addr' },
                { ts: dayTs, satoshis_net_earned: 50000000, username: 'acme-addr' }
              ]
            }]
          }
          if (key === 'HISTORICAL_PRICES') return [{ ts: dayTs, priceUSD: 100000 }]
          if (key === 'current_price') return [{ currentPrice: 100000 }]
          if (key === 'hashrate-history') {
            return [{ hashrateHistory: [{ ts: dayTs + 3600000, poolType: 'ocean', username: 'acme-addr', hashrate: 5e13 }] }]
          }
          return []
        }
        if (method === 'getGlobalConfig') {
          return {
            nominalPowerAvailability_MW: 10,
            phaseNominals: { phase1_5: { nominalPower_MW: 1.2 } }
          }
        }
        return {}
      }
    },
    globalDataLib: { getGlobalData: async () => [] }
  })

  const query = { start: dayTs - 1000, end: dayTs + 86400000, overwriteCache: true }

  const phased = await getRevenueSummary(ctx, { query: { ...query, phase: 'phase1_5' } }, {})
  const phaseRow = phased.log.find(e => e.revenueBTC > 0)
  t.is(phaseRow.revenueBTC, 0.5, 'phase row carries only its account')
  t.is(phaseRow.powerUtilization, null, 'site MW over the phase nominal is withheld')
  t.is(phaseRow.downtimeMWh, null, 'so is the downtime energy derived from it')

  const total = await getRevenueSummary(ctx, { query }, {})
  const totalRow = total.log.find(e => e.revenueBTC > 0)
  t.ok(totalRow.powerUtilization > 0, 'site rows keep the ratio')
  t.ok(Number.isFinite(totalRow.downtimeMWh), 'and the downtime energy')
})

test('getRevenueSummary monthly - rates use MEAN, totals use SUM', async (t) => {
  const day1 = Date.UTC(2024, 0, 15)
  const day2 = Date.UTC(2024, 0, 16)
  const days = [
    { ts: day1, powerW: 5_000_000, hashrateMhs: 100, btc: 0.5, price: 40000 },
    { ts: day2, powerW: 3_000_000, hashrateMhs: 300, btc: 0.3, price: 60000 }
  ]

  const result = await getRevenueSummary(makeMockCtx(days), {
    query: { start: day1 - 1000, end: day2 + 86400000, period: 'monthly' }
  }, {})

  t.is(result.log.length, 1, 'two days collapse to one monthly bucket')
  const m = result.log[0]
  t.ok(Math.abs(m.revenueBTC - 0.8) < 1e-9, 'revenueBTC summed')
  t.is(m.consumptionMWh, 192, 'consumptionMWh summed: 120 + 72')
  t.is(m.btcPrice, 50000, 'btcPrice averaged')
  t.is(m.powerW, 4_000_000, 'powerW averaged')
  t.is(m.hashrateMhs, 200, 'hashrateMhs averaged')
})

test('getRevenueSummary daily - a day with no hashrate sample is null, not zero', async (t) => {
  const day1 = Date.UTC(2024, 0, 15)
  const day2 = Date.UTC(2024, 0, 16)
  const days = [
    { ts: day1, powerW: 5_000_000, hashrateMhs: 100, btc: 0.5, price: 40000 },
    { ts: day2, powerW: 3_000_000, hashrateMhs: 300, btc: 0.3, price: 40000 }
  ]

  // day2 is paid for but never reported telemetry.
  const result = await getRevenueSummary(makeMockCtx(days, [days[0]]), {
    query: { start: day1 - 1000, end: day2 + 86400000, period: 'daily' }
  }, {})

  t.is(result.log.length, 2, 'the paid-for day still appears in the log')
  t.is(result.log[0].hashrateMhs, 100, 'the reported day keeps its value')
  t.is(result.log[1].hashrateMhs, null, 'the unreported day is null, not a zero-filled reading')
  t.is(result.log[1].hashRevenueUSDPerPHsPerDay, null, 'per-PH/s revenue is unknown too, not Infinity or 0')
  t.is(result.log[1].netHashRevenueUSDPerPHsPerDay, null, 'net per-PH/s revenue is unknown too, not Infinity or 0')
})

test('getRevenueSummary monthly - a missing hashrate day does not drag the mean down', async (t) => {
  const day1 = Date.UTC(2024, 0, 15)
  const day2 = Date.UTC(2024, 0, 16)
  const day3 = Date.UTC(2024, 0, 17)
  const days = [
    { ts: day1, powerW: 5_000_000, hashrateMhs: 100, btc: 0.5, price: 40000 },
    { ts: day2, powerW: 3_000_000, hashrateMhs: 300, btc: 0.3, price: 40000 },
    { ts: day3, powerW: 4_000_000, hashrateMhs: 0, btc: 0.4, price: 40000 }
  ]

  // day3 has a transaction but no stat entry; zero-filling it would average (100+300+0)/3 = 133.33.
  const result = await getRevenueSummary(makeMockCtx(days, days.slice(0, 2)), {
    query: { start: day1 - 1000, end: day3 + 86400000, period: 'monthly' }
  }, {})

  t.is(result.log.length, 1, 'three days collapse to one monthly bucket')
  t.is(result.log[0].hashrateMhs, 200, 'mean over the two days that reported: (100+300)/2')
})

test('getRevenueSummary - miningConsumptionMWh sums only the DCS rack meters, null where unmetered', async (t) => {
  const day1 = Date.UTC(2024, 0, 15)
  const day2 = Date.UTC(2024, 0, 16)
  const ctx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }], featureConfig: { centralDCSSetup: { enabled: true } } },
    net_r0: {
      jRequest: async (_key, method, payload) => {
        if (method === 'listThings') {
          return [{
            type: payload.fields.type && 'dcs-siemens',
            last: {
              snap: {
                stats: {
                  dcs_specific: {
                    equipment: {
                      power_meters: [
                        { equipment: 'Site-PM', role: 'site_main' },
                        { equipment: 'QGBT-01', role: 'rack' },
                        { equipment: 'QDFL-1P', role: 'rack' },
                        { equipment: 'CCM', role: 'ccm_principal' }
                      ]
                    }
                  }
                }
              }
            }
          }]
        }
        if (method === 'tailLog' && payload.aggrFields.by_meter_power_w) {
          return [
            { ts: day1, by_meter_power_w: { 'site-pm': 9_000_000, 'qgbt-01': 2_000_000, 'qdfl-1_p': 1_000_000, ccm: 5_000_000 } },
            { ts: day2, by_meter_power_w: {} }
          ]
        }
        if (method === 'tailLog') return [{ ts: day1, site_power_w: 9_000_000 }, { ts: day2, site_power_w: 9_000_000 }]
        return []
      }
    },
    globalDataLib: { getGlobalData: async () => [] }
  })
  const query = { start: day1, end: day2 + 86400000 - 1 }

  const daily = await getRevenueSummary(ctx, { query: { ...query, period: 'daily' } }, {})
  t.is(daily.log[0].consumptionMWh, 216, 'site consumption is unchanged')
  t.is(daily.log[0].miningConsumptionMWh, 72, 'rack meters only: (2 + 1) MW x 24h')
  t.is(daily.log[1].miningConsumptionMWh, null, 'a day without rack readings is unknown, not 0')
  t.is(daily.summary.totalMiningConsumptionMWh, 72)

  const unmetered = await getRevenueSummary(ctx, { query: { start: day2, end: query.end, period: 'monthly' } }, {})
  t.is(unmetered.log[0].miningConsumptionMWh, null, 'a month without rack readings is unknown, not 0')
  t.is(unmetered.summary.totalMiningConsumptionMWh, null)
})

test('getCostSummary - central DCS reads site power from the DCS worker', async (t) => {
  let captured
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }],
      featureConfig: { centralDCSSetup: { enabled: true, tag: 't-dcs-custom' } }
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'tailLog') {
          captured = payload
          return [{ ts: 1700006400000, site_power_w: 1000000 }]
        }
        return {}
      }
    },
    globalDataLib: { getGlobalData: async () => [] }
  })

  const result = await getCostSummary(mockCtx, { query: { start: 1700000000000, end: 1700100000000 } }, {})
  t.is(captured.type, 'dcs-siemens', 'queries the DCS worker type')
  t.is(captured.tag, 't-dcs-custom', 'with the configured DCS tag')
  t.is(result.log[0].consumptionMWh, 24, '1 MW over 24 h')
})

// ==================== EBITDA Tests ====================

test('getEbitda - happy path', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }]
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'tailLog') {
          return [{ ts: 1700006400000, site_power_w: 5000, hashrate_mhs_5m_sum_aggr: 100000 }]
        }
        if (method === 'getWrkExtData') {
          if (payload.query && payload.query.key === 'transactions') {
            return { data: [{ transactions: [{ ts: 1700006400000, changed_balance: 50000000 }] }] }
          }
          if (payload.query && payload.query.key === 'prices') {
            return { data: [{ prices: [{ ts: 1700006400000, price: 40000 }] }] }
          }
          if (payload.query && payload.query.key === 'current_price') {
            return { data: { USD: 40000 } }
          }
        }
        return {}
      }
    },
    globalDataLib: {
      getGlobalData: async () => []
    }
  })

  const mockReq = {
    query: { start: 1700000000000, end: 1700100000000, period: 'daily' }
  }

  const result = await getEbitda(mockCtx, mockReq, {})
  t.ok(result.log, 'should return log array')
  t.ok(result.summary, 'should return summary')
  t.ok(Array.isArray(result.log), 'log should be array')
  t.ok(result.summary.currentBtcPrice !== undefined, 'summary should have currentBtcPrice')
  t.pass()
})

test('getEbitda - missing start throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) },
    globalDataLib: { getGlobalData: async () => [] }
  })

  try {
    await getEbitda(mockCtx, { query: { end: 1700100000000 } }, {})
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_START_END', 'should throw missing start/end error')
  }
  t.pass()
})

test('getEbitda - invalid range throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) },
    globalDataLib: { getGlobalData: async () => [] }
  })

  try {
    await getEbitda(mockCtx, { query: { start: 1700100000000, end: 1700000000000 } }, {})
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_INVALID_DATE_RANGE', 'should throw invalid range error')
  }
  t.pass()
})

test('getEbitda - empty ork results', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async () => ({}) },
    globalDataLib: { getGlobalData: async () => [] }
  })

  const result = await getEbitda(mockCtx, { query: { start: 1700000000000, end: 1700100000000 } }, {})
  t.ok(result.log, 'should return log array')
  t.is(result.log.length, 0, 'log should be empty')
  t.pass()
})

test('processEbitdaPrices - processes valid data', (t) => {
  const results = [
    [{ prices: [{ ts: 1700006400000, price: 40000 }] }]
  ]
  const daily = processEbitdaPrices(results, 'UTC')
  t.ok(typeof daily === 'object', 'should return object')
  t.pass()
})

test('processEbitdaPrices - flat per-ork items with priceUSD (production shape)', (t) => {
  const results = [
    [
      { ts: 1700006400000, priceUSD: 40000 },
      { ts: 1700092800000, priceUSD: 41500 }
    ]
  ]
  const daily = processEbitdaPrices(results, 'UTC')
  t.is(daily[1700006400000], 40000, 'should extract priceUSD for first day')
  t.is(daily[1700092800000], 41500, 'should extract priceUSD for second day')
  t.pass()
})

test('calculateEbitdaSummary - calculates from log entries', (t) => {
  const log = [
    { revenueBTC: 0.5, revenueUSD: 20000, totalCostsUSD: 5000, ebitdaSelling: 15000, ebitdaHodl: 15000 },
    { revenueBTC: 0.3, revenueUSD: 12000, totalCostsUSD: 3000, ebitdaSelling: 9000, ebitdaHodl: 9000 }
  ]

  const summary = calculateEbitdaSummary(log, 40000)
  t.is(summary.totalRevenueBTC, 0.8, 'should sum BTC revenue')
  t.is(summary.totalRevenueUSD, 32000, 'should sum USD revenue')
  t.is(summary.totalCostsUSD, 8000, 'should sum costs')
  t.is(summary.totalEbitdaSelling, 24000, 'should sum selling EBITDA')
  t.is(summary.currentBtcPrice, 40000, 'should include current BTC price')
  t.ok(summary.avgBtcProductionCost !== null, 'should calculate avg production cost')
  t.pass()
})

test('calculateEbitdaSummary - handles empty log', (t) => {
  const summary = calculateEbitdaSummary([], 40000)
  t.is(summary.totalRevenueBTC, 0, 'should be zero')
  t.is(summary.avgBtcProductionCost, null, 'should be null')
  t.is(summary.currentBtcPrice, 40000, 'should include current price')
  t.pass()
})

// ==================== Cost Summary Tests ====================

test('getCostSummary - happy path', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }]
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'tailLog') {
          return [{ ts: 1700006400000, site_power_w: 5000 }]
        }
        if (method === 'getWrkExtData') {
          return { data: [{ prices: [{ ts: 1700006400000, price: 40000 }] }] }
        }
        return {}
      }
    },
    globalDataLib: {
      getGlobalData: async () => []
    }
  })

  const mockReq = {
    query: { start: 1700000000000, end: 1700100000000, period: 'daily' }
  }

  const result = await getCostSummary(mockCtx, mockReq, {})
  t.ok(result.log, 'should return log array')
  t.ok(result.summary, 'should return summary')
  t.ok(Array.isArray(result.log), 'log should be array')
  t.pass()
})

test('getCostSummary - missing start throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) },
    globalDataLib: { getGlobalData: async () => [] }
  })

  try {
    await getCostSummary(mockCtx, { query: { end: 1700100000000 } }, {})
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_START_END', 'should throw missing start/end error')
  }
  t.pass()
})

test('getCostSummary - invalid range throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) },
    globalDataLib: { getGlobalData: async () => [] }
  })

  try {
    await getCostSummary(mockCtx, { query: { start: 1700100000000, end: 1700000000000 } }, {})
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_INVALID_DATE_RANGE', 'should throw invalid range error')
  }
  t.pass()
})

test('getCostSummary - empty ork results', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async () => ({}) },
    globalDataLib: { getGlobalData: async () => [] }
  })

  const result = await getCostSummary(mockCtx, { query: { start: 1700000000000, end: 1700100000000 } }, {})
  t.ok(result.log, 'should return log array')
  t.is(result.log.length, 0, 'log should be empty')
  t.pass()
})

test('calculateCostSummary - calculates from log entries', (t) => {
  const log = [
    { energyCostsUSD: 5000, operationalCostsUSD: 1000, totalCostsUSD: 6000, consumptionMWh: 100, btcPrice: 40000 },
    { energyCostsUSD: 3000, operationalCostsUSD: 600, totalCostsUSD: 3600, consumptionMWh: 60, btcPrice: 42000 }
  ]

  const summary = calculateCostSummary(log)
  t.is(summary.totalEnergyCostsUSD, 8000, 'should sum energy costs')
  t.is(summary.totalOperationalCostsUSD, 1600, 'should sum operational costs')
  t.is(summary.totalCostsUSD, 9600, 'should sum total costs')
  t.is(summary.totalConsumptionMWh, 160, 'should sum consumption')
  t.ok(summary.avgAllInCostPerMWh !== null, 'should calculate avg all-in cost')
  t.ok(summary.avgBtcPrice !== null, 'should calculate avg BTC price')
  t.pass()
})

test('calculateCostSummary - handles empty log', (t) => {
  const summary = calculateCostSummary([])
  t.is(summary.totalCostsUSD, 0, 'should be zero')
  t.is(summary.avgAllInCostPerMWh, null, 'should be null')
  t.pass()
})

// ==================== Subsidy Fees Tests ====================

test('getSubsidyFees - happy path', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }]
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'getWrkExtData') {
          return [{ data: [{ ts: 1700006400000, blockReward: 6.25, blockTotalFees: 0.5 }] }]
        }
        return {}
      }
    }
  })

  const mockReq = {
    query: { start: 1700000000000, end: 1700100000000, period: 'daily' }
  }

  const result = await getSubsidyFees(mockCtx, mockReq, {})
  t.ok(result.log, 'should return log array')
  t.ok(result.summary, 'should return summary')
  t.ok(Array.isArray(result.log), 'log should be array')
  t.pass()
})

test('getSubsidyFees - missing start throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getSubsidyFees(mockCtx, { query: { end: 1700100000000 } }, {})
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_START_END', 'should throw missing start/end error')
  }
  t.pass()
})

test('getSubsidyFees - invalid range throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getSubsidyFees(mockCtx, { query: { start: 1700100000000, end: 1700000000000 } }, {})
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_INVALID_DATE_RANGE', 'should throw invalid range error')
  }
  t.pass()
})

test('getSubsidyFees - empty ork results', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async () => ({}) }
  })

  const result = await getSubsidyFees(mockCtx, { query: { start: 1700000000000, end: 1700100000000 } }, {})
  t.ok(result.log, 'should return log array')
  t.is(result.log.length, 0, 'log should be empty')
  t.pass()
})

test('calculateSubsidyFeesSummary - calculates from log entries', (t) => {
  const log = [
    { blockReward: 6.25, blockTotalFees: 0.5, blockSize: 1500000 },
    { blockReward: 6.25, blockTotalFees: 0.3, blockSize: 1300000 }
  ]

  const summary = calculateSubsidyFeesSummary(log)
  t.is(summary.totalBlockReward, 12.5, 'should sum block rewards')
  t.is(summary.totalBlockTotalFees, 0.8, 'should sum block fees')
  t.is(summary.totalBlockSize, 2800000, 'should sum block sizes')
  t.ok(summary.avgBlockReward !== null, 'should calculate avg block reward')
  t.is(summary.avgBlockReward, 6.25, 'should calculate correct avg block reward')
  t.ok(summary.avgBlockTotalFees !== null, 'should calculate avg block fees')
  t.is(summary.avgBlockSize, 1400000, 'should calculate correct avg block size')
  t.pass()
})

test('calculateSubsidyFeesSummary - handles empty log', (t) => {
  const summary = calculateSubsidyFeesSummary([])
  t.is(summary.totalBlockReward, 0, 'should be zero')
  t.is(summary.totalBlockTotalFees, 0, 'should be zero')
  t.is(summary.avgBlockReward, null, 'should be null')
  t.is(summary.avgBlockTotalFees, null, 'should be null')
  t.pass()
})

// ==================== Revenue Tests ====================

test('getRevenue - happy path', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }]
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'getWrkExtData') {
          return [{ transactions: [{ ts: 1700006400000, changed_balance: 0.5, mining_extra: { tx_fee: 0.001 } }] }]
        }
        return {}
      }
    }
  })

  const mockReq = {
    query: { start: 1700000000000, end: 1700100000000, period: 'daily' }
  }

  const result = await getRevenue(mockCtx, mockReq, {})
  t.ok(result.log, 'should return log array')
  t.ok(result.summary, 'should return summary')
  t.ok(Array.isArray(result.log), 'log should be array')
  t.pass()
})

test('getRevenue - missing start throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getRevenue(mockCtx, { query: { end: 1700100000000 } }, {})
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_START_END', 'should throw missing start/end error')
  }
  t.pass()
})

test('getRevenue - invalid range throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getRevenue(mockCtx, { query: { start: 1700100000000, end: 1700000000000 } }, {})
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_INVALID_DATE_RANGE', 'should throw invalid range error')
  }
  t.pass()
})

test('getRevenue - empty ork results', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async () => ({}) }
  })

  const result = await getRevenue(mockCtx, { query: { start: 1700000000000, end: 1700100000000 } }, {})
  t.ok(result.log, 'should return log array')
  t.is(result.log.length, 0, 'log should be empty')
  t.pass()
})

test('getRevenue - pool filter', async (t) => {
  let capturedPayload = null
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }]
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [{ transactions: [{ ts: 1700006400000, changed_balance: 0.5 }] }]
      }
    }
  })

  const mockReq = {
    query: { start: 1700000000000, end: 1700100000000, pool: 'f2pool' }
  }

  await getRevenue(mockCtx, mockReq, {})
  t.is(capturedPayload.type, 'minerpool-f2pool', 'should include pool in worker type')
  t.pass()
})

test('calculateRevenueSummary - calculates from log entries', (t) => {
  const log = [
    { revenueBTC: 0.5, feesBTC: 0.01, netRevenueBTC: 0.49 },
    { revenueBTC: 0.3, feesBTC: 0.005, netRevenueBTC: 0.295 }
  ]

  const summary = calculateRevenueSummary(log)
  t.is(summary.totalRevenueBTC, 0.8, 'should sum revenue')
  t.is(summary.totalFeesBTC, 0.015, 'should sum fees')
  t.ok(Math.abs(summary.totalNetRevenueBTC - 0.785) < 1e-10, 'should sum net revenue')
  t.pass()
})

test('calculateRevenueSummary - handles empty log', (t) => {
  const summary = calculateRevenueSummary([])
  t.is(summary.totalRevenueBTC, 0, 'should be zero')
  t.is(summary.totalFeesBTC, 0, 'should be zero')
  t.is(summary.totalNetRevenueBTC, 0, 'should be zero')
  t.pass()
})

// ==================== Revenue Summary Tests ====================

test('getRevenueSummary - happy path', async (t) => {
  const dayTs = 1700006400000
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }]
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'tailLog') {
          return [{ ts: dayTs, site_power_w: 5000, hashrate_mhs_5m_sum_aggr: 100000 }]
        }
        if (method === 'getWrkExtData') {
          if (payload.query && payload.query.key === 'transactions') {
            return [{ transactions: [{ ts: dayTs, changed_balance: 0.5, mining_extra: { tx_fee: 0.001 } }] }]
          }
          if (payload.query && payload.query.key === 'HISTORICAL_PRICES') {
            return [{ data: [{ ts: dayTs, priceUSD: 40000 }] }]
          }
          if (payload.query && payload.query.key === 'current_price') {
            return { data: { USD: 40000 } }
          }
          if (payload.query && payload.query.key === 'HISTORICAL_BLOCKSIZES') {
            return [{ data: [{ ts: dayTs, blockReward: 6.25, blockTotalFees: 0.5 }] }]
          }
          if (payload.query && payload.query.key === 'stats-history') {
            return []
          }
        }
        if (method === 'getGlobalConfig') {
          return { nominalPowerAvailability_MW: 10 }
        }
        return {}
      }
    },
    globalDataLib: {
      getGlobalData: async () => []
    }
  })

  const mockReq = {
    query: { start: 1700000000000, end: 1700100000000, period: 'daily' }
  }

  const result = await getRevenueSummary(mockCtx, mockReq, {})
  t.ok(result.log, 'should return log array')
  t.ok(result.summary, 'should return summary')
  t.ok(Array.isArray(result.log), 'log should be array')
  t.ok(result.summary.currentBtcPrice !== undefined, 'summary should have currentBtcPrice')
  if (result.log.length > 0) {
    const entry = result.log[0]
    t.ok(entry.revenueBTC !== undefined, 'entry should have revenueBTC')
    t.ok(entry.feesBTC !== undefined, 'entry should have feesBTC')
    t.ok(entry.revenueUSD !== undefined, 'entry should have revenueUSD')
    t.ok(entry.ebitdaSelling !== undefined, 'entry should have ebitdaSelling')
    t.ok(entry.ebitdaHodl !== undefined, 'entry should have ebitdaHodl')
    t.ok(entry.blockReward !== undefined, 'entry should have blockReward')
  }
  t.pass()
})

test('getRevenueSummary - missing start throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) },
    globalDataLib: { getGlobalData: async () => [] }
  })

  try {
    await getRevenueSummary(mockCtx, { query: { end: 1700100000000 } }, {})
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_START_END', 'should throw missing start/end error')
  }
  t.pass()
})

test('getRevenueSummary - invalid range throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) },
    globalDataLib: { getGlobalData: async () => [] }
  })

  try {
    await getRevenueSummary(mockCtx, { query: { start: 1700100000000, end: 1700000000000 } }, {})
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_INVALID_DATE_RANGE', 'should throw invalid range error')
  }
  t.pass()
})

test('getRevenueSummary - empty ork results', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async () => ({}) },
    globalDataLib: { getGlobalData: async () => [] }
  })

  const result = await getRevenueSummary(mockCtx, { query: { start: 1700000000000, end: 1700100000000 } }, {})
  t.ok(result.log, 'should return log array')
  t.is(result.log.length, 0, 'log should be empty')
  t.pass()
})

test('calculateDetailedRevenueSummary - calculates from log entries', (t) => {
  const log = [
    {
      revenueBTC: 0.5,
      revenueUSD: 20000,
      feesBTC: 0.01,
      feesUSD: 400,
      totalCostsUSD: 5000,
      consumptionMWh: 100,
      ebitdaSelling: 15000,
      ebitdaHodl: 15000,
      btcPrice: 40000,
      curtailmentRate: 0.1,
      powerUtilization: 0.8,
      miningNetUSD: 19000
    },
    {
      revenueBTC: 0.3,
      revenueUSD: 12600,
      feesBTC: 0.005,
      feesUSD: 210,
      totalCostsUSD: 3000,
      consumptionMWh: 60,
      ebitdaSelling: 9600,
      ebitdaHodl: 9600,
      btcPrice: 42000,
      curtailmentRate: 0.15,
      powerUtilization: 0.85,
      miningNetUSD: 12000
    }
  ]

  const summary = calculateDetailedRevenueSummary(log, 42000)
  t.is(summary.totalRevenueBTC, 0.8, 'should sum BTC revenue')
  t.is(summary.totalRevenueUSD, 32600, 'should sum USD revenue')
  t.is(summary.totalFeesBTC, 0.015, 'should sum fees BTC')
  t.is(summary.totalCostsUSD, 8000, 'should sum costs')
  t.is(summary.totalConsumptionMWh, 160, 'should sum consumption')
  t.is(summary.totalEbitdaSelling, 24600, 'should sum selling EBITDA')
  t.is(summary.totalMiningNetUSD, 31000, 'should sum net mining revenue')
  t.ok(summary.avgCostPerMWh !== null, 'should calculate avg cost per MWh')
  t.ok(summary.avgRevenuePerMWh !== null, 'should calculate avg revenue per MWh')
  t.is(summary.avgNetRevenuePerMWh, 193.75, 'should calculate avg net revenue per MWh')
  t.ok(summary.avgBtcPrice !== null, 'should calculate avg BTC price')
  t.ok(summary.avgCurtailmentRate !== null, 'should calculate avg curtailment rate')
  t.ok(summary.avgPowerUtilization !== null, 'should calculate avg power utilization')
  t.is(summary.currentBtcPrice, 42000, 'should include current BTC price')
  t.pass()
})

test('calculateDetailedRevenueSummary - handles empty log', (t) => {
  const summary = calculateDetailedRevenueSummary([], 42000)
  t.is(summary.totalRevenueBTC, 0, 'should be zero')
  t.is(summary.totalRevenueUSD, 0, 'should be zero')
  t.is(summary.totalFeesBTC, 0, 'should be zero')
  t.is(summary.avgCostPerMWh, null, 'should be null')
  t.is(summary.avgNetRevenuePerMWh, null, 'should be null')
  t.is(summary.currentBtcPrice, 42000, 'should include current price')
  t.pass()
})

// ==================== Hash Revenue Tests ====================

test('getHashRevenue - happy path', async (t) => {
  const dayTs = 1700006400000
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }]
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'tailLog') {
          return [{ ts: dayTs, hashrate_mhs_5m_sum_aggr: 500000000 }]
        }
        if (method === 'getWrkExtData') {
          if (payload.query && payload.query.key === 'transactions') {
            return [{ transactions: [{ ts: dayTs, changed_balance: 0.5, mining_extra: { tx_fee: 0.001 } }] }]
          }
          if (payload.query && payload.query.key === 'prices') {
            return [{ prices: [{ ts: dayTs, price: 40000 }] }]
          }
          if (payload.query && payload.query.key === 'current_price') {
            return [{ currentPrice: 40000 }]
          }
          if (payload.query && payload.query.key === 'HISTORICAL_HASHRATE') {
            return [{ data: [{ ts: dayTs, avgHashrateMHs: 500000000000000 }] }]
          }
        }
        return {}
      }
    }
  })

  const mockReq = {
    query: { start: 1700000000000, end: 1700100000000, period: 'daily' }
  }

  const result = await getHashRevenue(mockCtx, mockReq, {})
  t.ok(result.log, 'should return log array')
  t.ok(result.summary, 'should return summary')
  t.ok(Array.isArray(result.log), 'log should be array')
  if (result.log.length > 0) {
    const entry = result.log[0]
    t.ok(entry.revenueBTC !== undefined, 'entry should have revenueBTC')
    t.ok(entry.feesBTC !== undefined, 'entry should have feesBTC')
    t.ok(entry.revenueUSD !== undefined, 'entry should have revenueUSD')
    t.ok(entry.hashRevenueBTCPerPHsPerDay !== undefined, 'entry should have hashRevenueBTCPerPHsPerDay')
    t.ok(entry.hashRevenueUSDPerPHsPerDay !== undefined, 'entry should have hashRevenueUSDPerPHsPerDay')
    t.ok(entry.hashCostBTCPerPHsPerDay !== undefined, 'entry should have hashCostBTCPerPHsPerDay')
    t.ok(entry.hashCostUSDPerPHsPerDay !== undefined, 'entry should have hashCostUSDPerPHsPerDay')
    t.ok(entry.networkHashPriceBTCPerPHsPerDay !== undefined, 'entry should have networkHashPriceBTCPerPHsPerDay')
    t.ok(entry.networkHashPriceUSDPerPHsPerDay !== undefined, 'entry should have networkHashPriceUSDPerPHsPerDay')
    t.ok(entry.networkHashrateMhs !== undefined, 'entry should have networkHashrateMhs')
  }
  t.pass()
})

test('getHashRevenue - pool-only phase revenue stays out of the fleet metric', async (t) => {
  // Unique month so the daily-series month cache cannot leak across tests.
  const dayTs = Date.UTC(2033, 2, 15)
  const makeCtx = (featureConfig) => withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }],
      ...(featureConfig && { featureConfig })
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'tailLog') {
          return [{ ts: dayTs, hashrate_mhs_5m_sum_aggr: 1e9 }]
        }
        if (method === 'getWrkExtData') {
          if (payload.query && payload.query.key === 'transactions') {
            return [{
              transactions: [
                { ts: dayTs, satoshis_net_earned: 100000000, username: 'site-addr' },
                { ts: dayTs, satoshis_net_earned: 50000000, username: 'acme-addr' }
              ]
            }]
          }
          if (payload.query && payload.query.key === 'current_price') {
            return [{ currentPrice: 100000 }]
          }
        }
        return {}
      }
    }
  })

  const query = { start: dayTs - 1000, end: dayTs + 86400000, period: 'daily', overwriteCache: true }

  const phased = await getHashRevenue(makeCtx({
    phases: [
      { id: 'phase1', minerTelemetry: true, pool: { accounts: [{ poolType: 'ocean', username: 'site-addr' }] } },
      { id: 'phase1_5', minerTelemetry: false, pool: { accounts: [{ poolType: 'ocean', username: 'acme-addr' }] } }
    ]
  }), { query }, {})
  const phasedDay = phased.log.find(e => e.revenueBTC > 0)
  t.is(phasedDay.revenueBTC, 1, 'the pool-only account is excluded from the numerator')

  const plain = await getHashRevenue(makeCtx(null), { query }, {})
  const plainDay = plain.log.find(e => e.revenueBTC > 0)
  t.is(plainDay.revenueBTC, 1.5, 'without a phases config everything still counts')
})

test('getHashRevenue - missing start throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getHashRevenue(mockCtx, { query: { end: 1700100000000 } }, {})
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_START_END', 'should throw missing start/end error')
  }
  t.pass()
})

test('getHashRevenue - invalid range throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getHashRevenue(mockCtx, { query: { start: 1700100000000, end: 1700000000000 } }, {})
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_INVALID_DATE_RANGE', 'should throw invalid range error')
  }
  t.pass()
})

test('getHashRevenue - empty ork results', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async () => ({}) }
  })

  const result = await getHashRevenue(mockCtx, { query: { start: 1700000000000, end: 1700100000000 } }, {})
  t.ok(result.log, 'should return log array')
  t.is(result.log.length, 0, 'log should be empty')
  t.pass()
})

test('processNetworkHashrateData - processes array data', (t) => {
  const results = [
    [{ data: [{ ts: 1700006400000, avgHashrateMHs: 500000000000000 }] }]
  ]

  const daily = processNetworkHashrateData(results, 'UTC')
  t.ok(typeof daily === 'object', 'should return object')
  t.ok(Object.keys(daily).length > 0, 'should have entries')
  const key = Object.keys(daily)[0]
  t.is(daily[key], 500000000000000, 'should extract avgHashrateMHs')
  t.pass()
})

test('processNetworkHashrateData - flat per-ork items (production shape)', (t) => {
  const results = [
    [
      { ts: 1700006400000, avgHashrateMHs: 1019725948656278 },
      { ts: 1700092800000, avgHashrateMHs: 1029591824888537 }
    ]
  ]
  const daily = processNetworkHashrateData(results, 'UTC')
  t.is(daily[1700006400000], 1019725948656278, 'extracts avgHashrateMHs day 1')
  t.is(daily[1700092800000], 1029591824888537, 'extracts avgHashrateMHs day 2')
  t.pass()
})

test('processNetworkHashrateData - processes object-keyed data', (t) => {
  const results = [
    [{ data: { 1700006400000: { avgHashrateMHs: 500000000000000 } } }]
  ]

  const daily = processNetworkHashrateData(results, 'UTC')
  t.ok(typeof daily === 'object', 'should return object')
  t.ok(Object.keys(daily).length > 0, 'should have entries')
  t.pass()
})

test('processNetworkHashrateData - handles error results', (t) => {
  const results = [{ error: 'timeout' }]
  const daily = processNetworkHashrateData(results, 'UTC')
  t.is(Object.keys(daily).length, 0, 'should be empty for errors')
  t.pass()
})

test('calculateHashRevenueSummary - calculates from log entries', (t) => {
  const log = [
    {
      revenueBTC: 0.5,
      revenueUSD: 20000,
      feesBTC: 0.01,
      feesUSD: 400,
      hashRevenueBTCPerPHsPerDay: 0.001,
      hashRevenueUSDPerPHsPerDay: 40,
      hashCostBTCPerPHsPerDay: 0.00002,
      hashCostUSDPerPHsPerDay: 0.8,
      networkHashPriceBTCPerPHsPerDay: 0.0005,
      networkHashPriceUSDPerPHsPerDay: 20
    },
    {
      revenueBTC: 0.3,
      revenueUSD: 12600,
      feesBTC: 0.005,
      feesUSD: 210,
      hashRevenueBTCPerPHsPerDay: 0.0008,
      hashRevenueUSDPerPHsPerDay: 33.6,
      hashCostBTCPerPHsPerDay: 0.00001,
      hashCostUSDPerPHsPerDay: 0.42,
      networkHashPriceBTCPerPHsPerDay: 0.0004,
      networkHashPriceUSDPerPHsPerDay: 16.8
    }
  ]

  const summary = calculateHashRevenueSummary(log)
  t.is(summary.totalRevenueBTC, 0.8, 'should sum BTC revenue')
  t.is(summary.totalRevenueUSD, 32600, 'should sum USD revenue')
  t.is(summary.totalFeesBTC, 0.015, 'should sum fees BTC')
  t.is(summary.totalFeesUSD, 610, 'should sum fees USD')
  t.ok(summary.avgHashRevenueBTCPerPHsPerDay !== null, 'should calculate avg hash revenue BTC')
  t.ok(summary.avgHashRevenueUSDPerPHsPerDay !== null, 'should calculate avg hash revenue USD')
  t.ok(summary.avgHashCostBTCPerPHsPerDay !== null, 'should calculate avg hash cost BTC')
  t.ok(summary.avgHashCostUSDPerPHsPerDay !== null, 'should calculate avg hash cost USD')
  t.ok(summary.avgNetworkHashPriceBTCPerPHsPerDay !== null, 'should calculate avg network hash price BTC')
  t.ok(summary.avgNetworkHashPriceUSDPerPHsPerDay !== null, 'should calculate avg network hash price USD')
  t.pass()
})

test('calculateHashRevenueSummary - handles empty log', (t) => {
  const summary = calculateHashRevenueSummary([])
  t.is(summary.totalRevenueBTC, 0, 'should be zero')
  t.is(summary.totalRevenueUSD, 0, 'should be zero')
  t.is(summary.totalFeesBTC, 0, 'should be zero')
  t.is(summary.totalFeesUSD, 0, 'should be zero')
  t.is(summary.avgHashRevenueBTCPerPHsPerDay, null, 'should be null')
  t.is(summary.avgHashRevenueUSDPerPHsPerDay, null, 'should be null')
  t.is(summary.avgHashCostBTCPerPHsPerDay, null, 'should be null')
  t.is(summary.avgHashCostUSDPerPHsPerDay, null, 'should be null')
  t.is(summary.avgNetworkHashPriceBTCPerPHsPerDay, null, 'should be null')
  t.is(summary.avgNetworkHashPriceUSDPerPHsPerDay, null, 'should be null')
  t.pass()
})

test('processHourlyRevenues - merges hourlyRevenues buckets across orks', (t) => {
  const results = [
    { ts: 1, hourlyRevenues: [{ ts: 1700000000000, revenue: 0.01 }, { ts: 1700003600000, revenue: 0.02 }] },
    [{ ts: 2, hourlyRevenues: [{ ts: 1700000000000, revenue: 0.005 }] }]
  ]
  const log = processHourlyRevenues(results)
  t.is(log.length, 2, 'one entry per hour bucket')
  t.is(log[0].revenueBTC, 0.015, 'sums the same bucket across orks (0.01 + 0.005)')
  t.is(log[1].revenueBTC, 0.02, 'carries the second bucket')
  t.pass()
})

test('processHourlyRevenues - handles empty and errored results', (t) => {
  t.alike(processHourlyRevenues([]), [], 'empty results')
  t.alike(processHourlyRevenues([{ error: 'timeout' }, { ts: 1 }]), [], 'ignores errors and missing hourlyRevenues')
  t.pass()
})

test('getRevenueHourly - queries the pool with aggrHourly and shapes the log', async (t) => {
  let payload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'k' }] },
    net_r0: {
      jRequest: async (key, method, p) => {
        payload = p
        return { ts: 1, hourlyRevenues: [{ ts: 1700000000000, revenue: 0.03 }] }
      }
    }
  })
  const result = await getRevenueHourly(mockCtx, { query: { start: 1700000000000, end: 1700007200000, pool: 'ocean' } })
  t.is(payload.type, 'minerpool-ocean', 'targets the requested pool')
  t.is(payload.query.aggrHourly, 1, 'requests hourly aggregation')
  t.is(payload.query.key, 'transactions', 'reads the transactions source')
  t.is(result.log[0].revenueBTC, 0.03, 'exposes hourly revenue in BTC')
  t.is(result.summary.totalRevenueBTC, 0.03, 'summary totals the buckets')
  t.pass()
})

test('getRevenueHourly - timezone param never reinterprets start/end', async (t) => {
  let payload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'k' }] },
    net_r0: { jRequest: async (key, method, p) => { payload = p; return [] } }
  })

  const start = Date.UTC(2026, 5, 1, 0, 0, 0)
  const end = Date.UTC(2026, 5, 1, 1, 0, 0)

  await getRevenueHourly(mockCtx, {
    query: { start, end, timezone: 'America/Campo_Grande' }
  })

  t.is(payload.query.start, start, 'start is a true UTC instant, same as export')
  t.is(payload.query.end, end, 'end is a true UTC instant, same as export')
  t.pass()
})

test('getRevenueHourly - no pool param falls back to the generic minerpool type', async (t) => {
  let payload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'k' }] },
    net_r0: { jRequest: async (key, method, p) => { payload = p; return [] } }
  })
  const result = await getRevenueHourly(mockCtx, { query: { start: 1, end: 2 } })
  t.is(payload.type, 'minerpool', 'defaults to the generic minerpool type')
  t.alike(result, { log: [], summary: { totalRevenueBTC: 0 } }, 'empty source yields an empty shape')
  t.pass()
})

// --- LCOE-derived energy cost (Cost Input) -------------------------------------

test('processCostsData - an explicit zero energy cost stays zero, not derived', (t) => {
  const result = processCostsData([
    { site: 'site1', year: 2023, month: 11, energyCost: 0, operationalCost: 6000 }
  ])

  t.is(result['2023-11'].energyCostPerDay, 0, 'zero is a real value')
  t.is(result['2023-11'].operationalCostPerDay, 200, 'operational cost unchanged')
  t.pass()
})

test('processCostsData - a month with no energy cost is marked for derivation', (t) => {
  const result = processCostsData([
    { site: 'site1', year: 2023, month: 11, operationalCost: 6000 }
  ])

  t.is(result['2023-11'].energyCostPerDay, null, 'null marks "derive from consumption"')
  t.is(result['2023-11'].operationalCostPerDay, 200, 'operational cost still computed')
  t.pass()
})

test('resolveEnergyCostsUSD - existing rows behave exactly as before', (t) => {
  t.is(resolveEnergyCostsUSD({ energyCostPerDay: 1000 }, 24, 42), 1000, 'a stored cost wins over the LCOE')
  t.is(resolveEnergyCostsUSD({ energyCostPerDay: 0 }, 24, 42), 0, 'an explicit zero stays zero')
  t.is(resolveEnergyCostsUSD({}, 24, 42), 0, 'a month with no row stays zero, as today')
  t.pass()
})

test('resolveEnergyCostsUSD - derives from consumption when the month has no energy cost', (t) => {
  t.is(resolveEnergyCostsUSD({ energyCostPerDay: null }, 24, 42), 1008, '24 MWh x 42 $/MWh')
  t.is(resolveEnergyCostsUSD({ energyCostPerDay: null }, 24, 0), 0, 'no LCOE configured yields zero')
  t.pass()
})

test('resolveLcoeUsdPerMwh - reads the pinned effective value', (t) => {
  t.is(resolveLcoeUsdPerMwh({ lcoe: { source: 'current', effectiveUsdPerMwh: 42 } }), 42, 'reads effective')
  t.is(resolveLcoeUsdPerMwh({ lcoe: { source: 'custom', effectiveUsdPerMwh: 55 } }), 55, 'source does not matter here')
  t.is(resolveLcoeUsdPerMwh({ lcoe: { effectiveUsdPerMwh: 0 } }), 0, 'zero is valid')
  t.pass()
})

test('resolveLcoeUsdPerMwh - falls back to zero on anything unusable', (t) => {
  t.is(resolveLcoeUsdPerMwh(undefined), 0, 'no parameters')
  t.is(resolveLcoeUsdPerMwh({}), 0, 'no lcoe')
  t.is(resolveLcoeUsdPerMwh({ lcoe: {} }), 0, 'no effective value')
  t.is(resolveLcoeUsdPerMwh({ lcoe: { effectiveUsdPerMwh: 'cheap' } }), 0, 'non-numeric')
  t.is(resolveLcoeUsdPerMwh({ lcoe: { effectiveUsdPerMwh: -5 } }), 0, 'negative')
  t.pass()
})

test('getCostParameters - returns an empty object without globalDataLib', async (t) => {
  t.alike(await getCostParameters({}), {}, 'no lib, no parameters')
  t.alike(await getCostParameters({ globalDataLib: { getGlobalData: async () => null } }), {}, 'null reads as empty')
  t.alike(await getCostParameters({ globalDataLib: { getGlobalData: async () => ({ marginPct: 8 }) } }), { marginPct: 8 }, 'passes the stored object through')
  t.pass()
})

test('getEbitda - derives energy cost from consumption when the month carries none', async (t) => {
  const dayTs = 1700006400000
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    globalDataLib: {
      getGlobalData: async ({ type }) => {
        if (type === 'costParameters') {
          return { lcoe: { source: 'custom', customUsdPerMwh: 42, effectiveUsdPerMwh: 42 } }
        }
        return [{ site: 's', year: 2023, month: 11, operationalCost: 3000 }]
      }
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'tailLog') {
          return [{ ts: dayTs, site_power_w: 1000000, hashrate_mhs_5m_sum_aggr: 100 }]
        }
        return []
      }
    }
  })

  const result = await getEbitda(mockCtx, {
    query: { start: 1698710400000, end: 1700200000000, period: 'daily' }
  })

  const entry = result.log[0]
  // 1 MW over 24 h = 24 MWh; 24 x 42 = 1008
  t.is(entry.consumptionMWh, 24, 'daily consumption from site power')
  t.is(entry.energyCostsUSD, 1008, 'energy cost derived from consumption x LCOE')
  t.is(entry.operationalCostsUSD, 100, 'operational cost still comes from the stored month (3000/30)')
  t.is(entry.totalCostsUSD, 1108, 'total combines both')
  t.pass()
})

test('getEbitda - a stored energy cost is untouched by the fallback', async (t) => {
  const dayTs = 1700006400000
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    globalDataLib: {
      getGlobalData: async ({ type }) => {
        if (type === 'costParameters') return { lcoe: { effectiveUsdPerMwh: 42 } }
        return [{ site: 's', year: 2023, month: 11, energyCost: 30000, operationalCost: 3000 }]
      }
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'tailLog') return [{ ts: dayTs, site_power_w: 1000000 }]
        return []
      }
    }
  })

  const result = await getEbitda(mockCtx, {
    query: { start: 1698710400000, end: 1700200000000, period: 'daily' }
  })

  t.is(result.log[0].energyCostsUSD, 1000, 'stored 30000/30 wins over the LCOE derivation')
  t.pass()
})

test('getEbitda - no cost parameters configured leaves behaviour as it is today', async (t) => {
  const dayTs = 1700006400000
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    globalDataLib: {
      getGlobalData: async ({ type }) => {
        if (type === 'costParameters') return {}
        return [{ site: 's', year: 2023, month: 11, operationalCost: 3000 }]
      }
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'tailLog') return [{ ts: dayTs, site_power_w: 1000000 }]
        return []
      }
    }
  })

  const result = await getEbitda(mockCtx, {
    query: { start: 1698710400000, end: 1700200000000, period: 'daily' }
  })

  t.is(result.log[0].energyCostsUSD, 0, 'no LCOE, no derived cost — same as before this change')
  t.pass()
})

test('getEbitda - accepts the weekly period', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    globalDataLib: { getGlobalData: async () => [] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'tailLog') {
          return [
            { ts: 1700006400000, site_power_w: 1000000 },
            { ts: 1700092800000, site_power_w: 2000000 }
          ]
        }
        return []
      }
    }
  })

  const result = await getEbitda(mockCtx, {
    query: { start: 1700000000000, end: 1700200000000, period: 'weekly' }
  })

  t.ok(Array.isArray(result.log), 'returns a log')
  t.is(result.log.length, 1, 'both days collapse into one weekly bucket')
  t.pass()
})

// ==================== Power Cost Tests ====================

const JAN_1 = 1767225600000
const JAN_10 = 1768003200000
const JAN_11 = 1768089600000
const JAN_31 = 1769817600000
const DAY_MS = 86400000

function createPowerCostCtx ({ power = [], transactions = [], prices = [], costs = [] } = {}) {
  return withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'tailLog') {
          return power
        }
        if (method === 'getWrkExtData') {
          if (payload.query && payload.query.key === 'transactions') return transactions
          if (payload.query && payload.query.key === 'HISTORICAL_PRICES') return prices
        }
        return []
      }
    },
    globalDataLib: {
      getGlobalData: async () => costs
    }
  })
}

test('getPowerCost - rolls daily data into monthly per-MWh points', async (t) => {
  const mockCtx = createPowerCostCtx({
    power: [
      { ts: JAN_10, site_power_w: 2000000 },
      { ts: JAN_11, site_power_w: 2000000 }
    ],
    transactions: [
      { ts: JAN_10, transactions: [{ changed_balance: 0.5 }] },
      { ts: JAN_11, transactions: [{ changed_balance: 0.25 }] }
    ],
    prices: [
      { ts: JAN_10, priceUSD: 100000 },
      { ts: JAN_11, priceUSD: 100000 }
    ],
    costs: [
      { site: 's1', year: 2026, month: 1, energyCost: 40000, operationalCost: 8000 }
    ]
  })

  const result = await getPowerCost(mockCtx, { query: { start: JAN_1, end: JAN_31 } })
  t.is(result.log.length, 1, 'should return one month')
  const jan = result.log[0]
  t.is(jan.ts, JAN_1, 'month bucket should be the UTC month start')
  // avg 2 MW over 2 days -> 2 * 24 * 2 = 96 MWh; revenue 0.75 BTC * 100k = 75000 USD
  t.is(jan.revenueUSD, 75000 / 96, 'revenue should be USD per MWh')
  t.is(jan.hashCostUSD, 48000 / 96, 'cost should be production costs per MWh')
  t.pass()
})

test('getPowerCost - skips revenue on days without a BTC price', async (t) => {
  const mockCtx = createPowerCostCtx({
    power: [{ ts: JAN_10, site_power_w: 1000000 }],
    transactions: [
      { ts: JAN_10, transactions: [{ changed_balance: 1 }] },
      { ts: JAN_11, transactions: [{ changed_balance: 5 }] }
    ],
    prices: [{ ts: JAN_10, priceUSD: 100000 }]
  })

  const result = await getPowerCost(mockCtx, { query: { start: JAN_1, end: JAN_31 } })
  // only Jan 10 revenue counts: 1 BTC * 100k over 24 MWh
  t.is(result.log[0].revenueUSD, 100000 / 24, 'priceless days should not contribute revenue')
  t.pass()
})

test('getPowerCost - sums costs across sites and drops months outside the range', async (t) => {
  const mockCtx = createPowerCostCtx({
    power: [{ ts: JAN_10, site_power_w: 1000000 }],
    costs: [
      { site: 's1', year: 2026, month: 1, energyCost: 1000, operationalCost: 200 },
      { site: 's2', year: 2026, month: 1, energyCost: 800, operationalCost: 400 },
      { site: 's1', year: 2026, month: 3, energyCost: 9999, operationalCost: 0 },
      { year: 2026, month: 1, energyCost: 500, operationalCost: 0 }
    ]
  })

  const result = await getPowerCost(mockCtx, { query: { start: JAN_1, end: JAN_31 } })
  t.is(result.log.length, 1, 'out-of-range months should be dropped')
  t.is(result.log[0].hashCostUSD, 2400 / 24, 'should sum costs across sites and skip site-less rows')
  t.pass()
})

test('getPowerCost - empty results', async (t) => {
  const mockCtx = createPowerCostCtx()
  const result = await getPowerCost(mockCtx, { query: { start: JAN_1, end: JAN_31 } })
  t.alike(result.log, [], 'should return empty log')
  t.pass()
})

test('getPowerCost - a local month boundary keeps a UTC-Jan-1 sample in December for a west-of-UTC zone', async (t) => {
  const sampleUtc = JAN_1 + 2 * 3600000 // Jan 1 02:00 UTC = Dec 31 22:00 in America/Campo_Grande
  const mockCtx = createPowerCostCtx({
    power: [{ ts: sampleUtc, site_power_w: 2000000 }],
    transactions: [{ ts: sampleUtc, transactions: [{ changed_balance: 0.5 }] }],
    prices: [{ ts: sampleUtc, priceUSD: 40000 }]
  })

  const result = await getPowerCost(mockCtx, {
    query: {
      start: Date.UTC(2025, 10, 1),
      end: Date.UTC(2026, 1, 15),
      timezone: 'America/Campo_Grande'
    }
  })

  t.is(result.log.length, 1, 'one monthly bucket')
  const decemberLocalStart = Date.UTC(2025, 11, 1, 4) // Campo_Grande midnight Dec 1 2025 = 04:00 UTC
  t.is(result.log[0].ts, decemberLocalStart, 'the Dec-31-local sample is attributed to December, not UTC January')
  t.ok(result.log[0].revenueUSD > 0, 'revenue still computed for that bucket')
  t.pass()
})

test('sumCostsByMonth - buckets by local month start, not the UTC label', (t) => {
  const startMonthTs = localMonthStart(Date.UTC(2025, 11, 1), 'America/Campo_Grande')
  const endMonthTs = localMonthStart(Date.UTC(2026, 0, 1), 'America/Campo_Grande')
  const byMonth = sumCostsByMonth(
    [{ site: 's1', year: 2025, month: 12, energyCost: 1000, operationalCost: 500 }],
    startMonthTs,
    endMonthTs,
    'America/Campo_Grande'
  )
  const decemberLocalStart = Date.UTC(2025, 11, 1, 4)
  t.is(byMonth[decemberLocalStart], 1500, 'costs land on the local December month start')
  t.pass()
})

test('getPowerCost - missing start throws', async (t) => {
  const mockCtx = createPowerCostCtx()
  try {
    await getPowerCost(mockCtx, { query: { end: JAN_31 } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_START_END', 'should throw missing start/end error')
  }
  t.pass()
})

test('processDailyRevenueBtc - prefers changed_balance and falls back to satoshis', (t) => {
  const daily = processDailyRevenueBtc([
    [
      {
        ts: JAN_10,
        transactions: [
          { changed_balance: 0.5, satoshis_net_earned: 999 },
          { satoshis_net_earned: 50000000 },
          { note: 'no amounts' }
        ]
      }
    ]
  ], JAN_1, JAN_31, 'UTC')
  t.is(daily[JAN_10], 1, 'should sum 0.5 BTC + 0.5 BTC')
  t.pass()
})

test('processDailyAvgPrices - averages price points within a day', (t) => {
  const daily = processDailyAvgPrices([
    [
      { ts: JAN_10, priceUSD: 90000 },
      { ts: JAN_10 + 3600000, priceUSD: 110000 },
      { ts: JAN_31 + DAY_MS, priceUSD: 500 }
    ]
  ], JAN_1, JAN_31, 'UTC')
  t.is(daily[JAN_10], 100000, 'should average intra-day prices')
  t.absent(daily[JAN_31 + DAY_MS], 'should drop out-of-range days')
  t.pass()
})

test('resolveCostParametersForMonth - a month without an override resolves to the base doc', (t) => {
  const base = { marginPct: 8, lcoe: { source: 'current', effectiveUsdPerMwh: 42 } }

  t.alike(resolveCostParametersForMonth(base, '2026-08'), base, 'no overrides map at all')
  t.alike(resolveCostParametersForMonth(base), base, 'no month key')
  t.alike(resolveCostParametersForMonth({ ...base, overrides: {} }, '2026-08'), { ...base, overrides: {} }, 'empty overrides map')
  t.alike(resolveCostParametersForMonth({ ...base, overrides: { '2026-09': { marginPct: 1 } } }, '2026-08'), { ...base, overrides: { '2026-09': { marginPct: 1 } } }, 'a different month is overridden')
  t.alike(resolveCostParametersForMonth(undefined, '2026-08'), {}, 'no parameters at all')
  t.pass()
})

test('resolveCostParametersForMonth - an override merges over the base, lcoe one level deep', (t) => {
  const base = {
    minerAmortizationUsd: 45000,
    marginPct: 8,
    lcoe: { source: 'current', customUsdPerMwh: null, effectiveUsdPerMwh: 42 },
    overrides: { '2026-08': { marginPct: 10, lcoe: { source: 'custom', customUsdPerMwh: 51, effectiveUsdPerMwh: 51 } } }
  }

  const merged = resolveCostParametersForMonth(base, '2026-08')
  t.is(merged.marginPct, 10, 'override wins')
  t.is(merged.minerAmortizationUsd, 45000, 'untouched base fields survive')
  t.is(merged.lcoe.effectiveUsdPerMwh, 51, 'override lcoe wins')

  const partial = resolveCostParametersForMonth({
    ...base,
    overrides: { '2026-08': { lcoe: { effectiveUsdPerMwh: 99 } } }
  }, '2026-08')
  t.is(partial.lcoe.effectiveUsdPerMwh, 99, 'partial lcoe override wins')
  t.is(partial.lcoe.source, 'current', 'unset lcoe keys fall back to the base')
  t.is(partial.marginPct, 8, 'base margin kept when the override omits it')
  t.pass()
})

test('resolveLcoeUsdPerMwh - resolves per month, base untouched', (t) => {
  const params = {
    lcoe: { effectiveUsdPerMwh: 42 },
    overrides: { '2026-08': { lcoe: { effectiveUsdPerMwh: 60 } } }
  }

  t.is(resolveLcoeUsdPerMwh(params, '2026-08'), 60, 'overridden month')
  t.is(resolveLcoeUsdPerMwh(params, '2026-07'), 42, 'month without an override keeps the base')
  t.is(resolveLcoeUsdPerMwh(params), 42, 'no month key behaves exactly as before')
  t.is(resolveLcoeUsdPerMwh({ overrides: { '2026-08': { lcoe: { effectiveUsdPerMwh: -5 } } } }, '2026-08'), 0, 'an unusable override still falls back to zero')
  t.pass()
})

test('getEbitda - a monthly LCOE override only moves its own month', async (t) => {
  const octTs = 1697068800000 // 2023-10-12
  const novTs = 1700006400000 // 2023-11-15

  const buildCtx = (costParameters) => withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    globalDataLib: {
      getGlobalData: async ({ type }) => {
        if (type === 'costParameters') return costParameters
        return [
          { site: 's', year: 2023, month: 10, operationalCost: 3100 },
          { site: 's', year: 2023, month: 11, operationalCost: 3000 }
        ]
      }
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'tailLog') {
          return [
            { ts: octTs, site_power_w: 1000000, hashrate_mhs_5m_sum_aggr: 100 },
            { ts: novTs, site_power_w: 1000000, hashrate_mhs_5m_sum_aggr: 100 }
          ]
        }
        return []
      }
    }
  })

  const query = { query: { start: 1693526400000, end: 1700200000000, period: 'daily' } }
  const base = { lcoe: { source: 'current', customUsdPerMwh: null, effectiveUsdPerMwh: 42 } }

  const overridden = await getEbitda(buildCtx({
    ...base,
    overrides: { '2023-11': { lcoe: { source: 'custom', customUsdPerMwh: 60, effectiveUsdPerMwh: 60 } } }
  }), query)

  t.is(overridden.log.length, 2, 'one entry per day')
  t.is(overridden.log[0].energyCostsUSD, 1008, 'October uses the base LCOE (24 MWh x 42)')
  t.is(overridden.log[1].energyCostsUSD, 1440, 'November uses its override (24 MWh x 60)')

  const plain = await getEbitda(buildCtx(base), query)
  t.is(plain.log[0].energyCostsUSD, 1008, 'no overrides: October unchanged')
  t.is(plain.log[1].energyCostsUSD, 1008, 'no overrides: November falls back to the base too')
  t.alike(plain, await getEbitda(buildCtx({ ...base, overrides: {} }), query), 'an empty overrides map changes nothing')

  t.pass()
})

// The mempool worker only serves HISTORICAL_* keys and destructures `prices` out of its
// fallback reply, so asking for 'prices' returned nothing and every historical day was
// silently valued at today's spot price.
test('getEbitda and getHashRevenue request the historical price key the mempool worker serves', async (t) => {
  const requestedKeys = []
  const dayTs = 1700006400000

  const makeCtx = () => withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'tailLog') return [{ ts: dayTs, site_power_w: 5000, hashrate_mhs_5m_sum_aggr: 100 }]
        if (method === 'getWrkExtData') {
          const qKey = payload.query && payload.query.key
          if (payload.type === 'mempool') requestedKeys.push(qKey)
          if (qKey === 'transactions') return [{ ts: dayTs, transactions: [{ ts: dayTs, changed_balance: 0.5 }] }]
          if (qKey === 'HISTORICAL_PRICES') return [{ ts: dayTs, priceUSD: 61000 }]
        }
        return []
      }
    },
    globalDataLib: { getGlobalData: async () => [] }
  })

  const req = { query: { start: dayTs - 86400000, end: dayTs + 86400000 } }
  await getEbitda(makeCtx(), req, {})
  await getHashRevenue(makeCtx(), req, {})

  t.ok(requestedKeys.includes('HISTORICAL_PRICES'), 'asks for the key the worker actually serves')
  t.absent(requestedKeys.includes('prices'), 'never asks for the stripped `prices` key')
  t.pass()
})

// ==================== Production Costs Tests ====================

test('getProductionCosts - keeps every month overlapping the range', async (t) => {
  const AUG_1_UTC = Date.UTC(2026, 7, 1)
  const SEP_1_UTC = Date.UTC(2026, 8, 1)
  const FOUR_HOURS = 4 * 60 * 60 * 1000
  const mockCtx = {
    globalDataLib: {
      getGlobalData: async () => [7, 8, 9, 10].map(month => ({ site: 'Ivinhema', year: 2026, month, operationalCost: month }))
    }
  }
  const months = async (start, end) => (await getProductionCosts(mockCtx, start, end)).map(r => r.month)

  t.alike(await months(AUG_1_UTC, SEP_1_UTC - 1), [8], 'UTC month bounds select only that month')
  t.alike(await months(AUG_1_UTC + FOUR_HOURS, SEP_1_UTC + FOUR_HOURS - 1), [8, 9], 'a local-midnight start must not drop the requested month')
  t.alike(await months(Date.UTC(2026, 7, 15), Date.UTC(2026, 7, 20)), [8], 'a range inside a month keeps that month')
  t.pass()
})

test('getEbitda - passes a limit that covers every day in the range to mempool history', async (t) => {
  const start = 1700000000000
  const end = start + 400 * 86400000
  const queries = []
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'getWrkExtData' && payload.query) queries.push(payload.query)
        return []
      }
    },
    globalDataLib: { getGlobalData: async () => [] }
  })

  await getEbitda(mockCtx, { query: { start, end, period: 'monthly' } }, {})

  const prices = queries.find(q => q.key === 'HISTORICAL_PRICES')
  t.ok(prices.limit > 400, 'limit exceeds the number of daily rows in the range')
})

test('getRevenueSummary - reads the documented nominal power key and emits nominal and downtime energy', async (t) => {
  const dayTs = 1700006400000
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'tailLog') return [{ ts: dayTs, site_power_w: 5000000 }]
        if (method === 'getGlobalConfig') return { nominalAvailablePowerMWh: 10 }
        return []
      }
    },
    globalDataLib: { getGlobalData: async () => [] }
  })

  const { log: [entry] } = await getRevenueSummary(mockCtx, { query: { start: dayTs, end: dayTs + 1, period: 'daily' } }, {})

  t.is(entry.powerUtilization, 0.5)
  t.is(entry.nominalConsumptionMWh, 240)
  t.is(entry.availableEnergyMWh, 0)
  t.is(entry.downtimeMWh, 120)
  t.is(entry.curtailmentMWh, 0)
  t.is(entry.curtailmentRate, 0)
  t.is(entry.operationalIssuesRate, 0)
})

test('getRevenueSummary - monthly btcProductionCost is total cost over total BTC, not a mean of daily ratios', async (t) => {
  const day1 = 1700006400000
  const day2 = day1 + 86400000
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'getWrkExtData' && payload.query.key === 'transactions') {
          return [{ transactions: [{ ts: day1, changed_balance: 1 }, { ts: day2, changed_balance: 0.001 }] }]
        }
        return []
      }
    },
    globalDataLib: {
      getGlobalData: async ({ type }) => type === 'productionCosts' ? [{ year: 2023, month: 11, energyCost: 3000 }] : []
    }
  })

  const { log: [month] } = await getRevenueSummary(mockCtx, { query: { start: day1, end: day2 + 1, period: 'monthly' } }, {})

  t.is(Math.round(month.btcProductionCost), 200)
})

test('getRevenueSummary - folds forecast energy sales, pool rebates and net-of-tax into the daily row', async (t) => {
  const dayTs = 1700006400000
  const hour = 3600000
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'tailLog') return [{ ts: dayTs, site_power_w: 5000000, hashrate_mhs_5m_sum_aggr: 1000000000 }]
        if (method !== 'getWrkExtData') return []
        switch (payload.query.key) {
          case 'transactions': return [{ transactions: [{ ts: dayTs, changed_balance: 1 }] }]
          case 'HISTORICAL_PRICES': return [{ data: [{ ts: dayTs, priceUSD: 40000 }] }]
          case 'forecastSettings': return [{ miningRevenueTaxFees: { percent: 4, fixed: 2 } }]
          case 'forecastHistory': return [{
            hourlyForecast: [
              { start: dayTs, isEnergySelected: true, energySellPrice: 100, energySalesRevenue: 100, energySalesRevenueSelected: 100, energySalesRevenuePerMwh: 10, energySalesTaxesAndFees: 2, miningRevenue: 50, taxesAndFees: 1 },
              { start: dayTs + hour, isEnergySelected: false, energySalesRevenue: 100, energySalesRevenueSelected: 100, energySalesRevenuePerMwh: 10, energySalesTaxesAndFees: 2, miningRevenue: 500, taxesAndFees: 20 }
            ]
          }]
          default: return []
        }
      }
    },
    globalDataLib: {
      getGlobalData: async ({ type }) => type === 'poolRebates' ? [{ ts: dayTs + hour, amountBTC: 0.5 }] : []
    }
  })

  const { log: [row], summary } = await getRevenueSummary(mockCtx, { query: { start: dayTs, end: dayTs + 86400000, period: 'daily' } }, {})

  t.is(row.revenueBTC, 1.5)
  t.is(row.payoutBTC, 1)
  t.is(row.rebateBTC, 0.5)
  t.is(row.soldMWh, 10)
  t.is(row.availableMWh, 20)
  t.is(row.energySalesNetUSD, 98)
  t.is(row.allMineNetUSD, 550, 'forecast miningRevenue is already net')
  t.is(row.allSellNetUSD, 200, 'forecast energySalesRevenue is already net')
  t.is(row.optimalNetUSD, 600)
  t.is(row.curtailmentMWh, 0)
  t.is(row.availableEnergyMWh, 0)
  t.is(row.miningNetUSD, 57360)
  t.is(row.netCashUSD, 57458)
  t.is(row.energyRevenuePerMWh, 500, 'gross mining revenue per MWh ignores tax fees')
  t.is(row.netEnergyRevenuePerMWh, 478, 'net mining revenue per MWh is net of tax fees')
  t.is(row.hashRevenueUSDPerPHsPerDay, 60000, 'gross hash revenue per PH/s ignores tax fees')
  t.is(row.netHashRevenueUSDPerPHsPerDay, 57360, 'net hash revenue per PH/s is net of tax fees')
  t.is(summary.totalRebateBTC, 0.5)
  t.is(summary.totalNetCashUSD, 57458)
  t.is(summary.avgRevenuePerMWh, 500, 'gross avg revenue per MWh')
  t.is(summary.avgNetRevenuePerMWh, 478, 'net avg revenue per MWh')
})

test('getRevenueSummary - an energy-selected hour the forecast decided to mine is not sold', async (t) => {
  const dayTs = 1700006400000
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'tailLog') return [{ ts: dayTs, site_power_w: 5000000 }]
        if (method !== 'getWrkExtData') return []
        if (payload.query.key === 'forecastHistory') {
          return [{
            hourlyForecast: [
              { start: dayTs, decision: 'mine', isEnergySelected: true, energySellPrice: 100, energySalesRevenue: 100, energySalesRevenuePerMwh: 10, energySalesTaxesAndFees: 2, miningRevenue: 500 }
            ]
          }]
        }
        return []
      }
    },
    globalDataLib: { getGlobalData: async () => [] }
  })

  const { log: [row] } = await getRevenueSummary(mockCtx, { query: { start: dayTs, end: dayTs + 86400000, period: 'daily' } }, {})

  t.is(row.soldMWh, 0)
  t.is(row.energySalesNetUSD, 0)
  t.is(row.availableMWh, 10, 'the hour still counts as available energy')
  t.is(row.optimalNetUSD, 500)
})
