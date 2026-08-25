'use strict'

const test = require('brittle')
const {
  getEnergyBalance,
  getCostParameters,
  resolveLcoeUsdPerMwh,
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
  getStartOfMonthUtc,
  processDailyRevenueBtc,
  processDailyAvgPrices,
  processNetworkHashrateData,
  calculateHashRevenueSummary
} = require('../../../workers/lib/server/handlers/finance.handlers')
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

test('getEnergyBalance - reads a grouped range-string ts on the electricity stats', async (t) => {
  // Both stats-history queries pass groupRange, so the worker answers with ts as a range
  // string. Read raw, getStartOfDay turns it into NaN and every energy reading is dropped,
  // leaving curtailment null on a day that has one.
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
          if (payload.query && payload.query.key === 'current_price') {
            return [{ currentPrice: 40000 }]
          }
          if (payload.query && payload.query.key === 'stats-history') {
            return [{
              data: [{
                ts: `${dayTs}-${dayTs + 86399999}`,
                energy_aggr: { active_energy_in_aggr: 1, ute_energy_aggr: 1 }
              }]
            }]
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
  const day = result.log.find(entry => entry.ts === dayTs)

  t.ok(day, 'should return the day')
  // consumptionMWh is 5000 W over 24 h = 0.12 MWh, so 1 MWh in leaves 0.88 curtailed
  t.is(day.curtailmentMWh, 0.88, 'should derive curtailment from the range-string bucket')
  t.ok(day.operationalIssuesRate !== null, 'should derive the operational issues rate too')
  t.pass()
})

test('processPriceData - processes mempool price data', (t) => {
  const results = [
    [{ ts: 1700006400000, priceUSD: 40000 }]
  ]

  const daily = processPriceData(results)
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

function makeMockCtx (days) {
  return withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (_key, method, payload) => {
        if (method === 'tailLog') {
          return days.map(d => ({ ts: d.ts, site_power_w: d.powerW, hashrate_mhs_5m_sum_aggr: d.hashrateMhs || 0 }))
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
  const daily = processEbitdaPrices(results)
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
  const daily = processEbitdaPrices(results)
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
      powerUtilization: 0.8
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
      powerUtilization: 0.85
    }
  ]

  const summary = calculateDetailedRevenueSummary(log, 42000)
  t.is(summary.totalRevenueBTC, 0.8, 'should sum BTC revenue')
  t.is(summary.totalRevenueUSD, 32600, 'should sum USD revenue')
  t.is(summary.totalFeesBTC, 0.015, 'should sum fees BTC')
  t.is(summary.totalCostsUSD, 8000, 'should sum costs')
  t.is(summary.totalConsumptionMWh, 160, 'should sum consumption')
  t.is(summary.totalEbitdaSelling, 24600, 'should sum selling EBITDA')
  t.ok(summary.avgCostPerMWh !== null, 'should calculate avg cost per MWh')
  t.ok(summary.avgRevenuePerMWh !== null, 'should calculate avg revenue per MWh')
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

  const daily = processNetworkHashrateData(results)
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
  const daily = processNetworkHashrateData(results)
  t.is(daily[1700006400000], 1019725948656278, 'extracts avgHashrateMHs day 1')
  t.is(daily[1700092800000], 1029591824888537, 'extracts avgHashrateMHs day 2')
  t.pass()
})

test('processNetworkHashrateData - processes object-keyed data', (t) => {
  const results = [
    [{ data: { 1700006400000: { avgHashrateMHs: 500000000000000 } } }]
  ]

  const daily = processNetworkHashrateData(results)
  t.ok(typeof daily === 'object', 'should return object')
  t.ok(Object.keys(daily).length > 0, 'should have entries')
  t.pass()
})

test('processNetworkHashrateData - handles error results', (t) => {
  const results = [{ error: 'timeout' }]
  const daily = processNetworkHashrateData(results)
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
  ], JAN_1, JAN_31)
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
  ], JAN_1, JAN_31)
  t.is(daily[JAN_10], 100000, 'should average intra-day prices')
  t.absent(daily[JAN_31 + DAY_MS], 'should drop out-of-range days')
  t.pass()
})

test('getStartOfMonthUtc - buckets to UTC month start', (t) => {
  t.is(getStartOfMonthUtc(JAN_10), JAN_1)
  t.is(getStartOfMonthUtc(JAN_1), JAN_1)
  t.pass()
})
