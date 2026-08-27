'use strict'

const {
  WORKER_TYPES,
  AGGR_FIELDS,
  PERIOD_TYPES,
  MINERPOOL_EXT_DATA_KEYS,
  RPC_METHODS,
  GLOBAL_DATA_TYPES,
  METRICS_TIME,
  BTC_SATS
} = require('../../constants')
const { getStartOfDay, safeDiv, runParallel } = require('../../utils')
const { parseEntryTs } = require('../../metrics.utils')
const { aggregateByPeriod } = require('../../period.utils')
const { getConsumption, getHashrate } = require('./metrics.handlers')
const {
  validateStartEnd,
  normalizeTimestampMs,
  processTransactions,
  extractCurrentPrice,
  processBlockData
} = require('./finance.utils')

// Daily site power and hashrate come from the metrics handlers: DCS-aware and averaged per
// bucket, unlike the range-aggr daily docs, which are raw sample sums and only exist for
// powermeter racks.
async function getDailySeries (ctx, start, end, handler, field) {
  const { log } = await handler(ctx, { query: { start, end, interval: '1d' } })
  return Object.fromEntries(log.map(entry => [getStartOfDay(entry.ts), entry[field] || 0]))
}

// ==================== Energy Balance ====================

async function getEnergyBalance (ctx, req) {
  const { start, end } = validateStartEnd(req)
  const period = req.query.period || PERIOD_TYPES.DAILY

  const [
    dailyConsumption,
    transactionResults,
    priceResults,
    currentPriceResults,
    productionCosts,
    activeEnergyInResults,
    uteEnergyResults,
    globalConfigResults,
    costParameters
  ] = await runParallel([
    (cb) => getDailySeries(ctx, start, end, getConsumption, 'powerW')
      .then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MINERPOOL,
      query: { key: MINERPOOL_EXT_DATA_KEYS.TRANSACTIONS, start, end }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'HISTORICAL_PRICES', start, end }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'current_price' }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => getProductionCosts(ctx, start, end)
      .then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.ELECTRICITY,
      query: { key: 'stats-history', start, end, groupRange: '1D' }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.ELECTRICITY,
      query: { key: 'stats-history', start, end, groupRange: '1D' }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GLOBAL_CONFIG, {})
      .then(r => cb(null, r)).catch(cb),

    (cb) => getCostParameters(ctx)
      .then(r => cb(null, r)).catch(cb)
  ])

  const dailyTransactions = processTransactions(transactionResults)
  const dailyPrices = processPriceData(priceResults)
  const currentBtcPrice = extractCurrentPrice(currentPriceResults)
  const costsByMonth = processCostsData(productionCosts)
  const dailyActiveEnergyIn = processEnergyData(activeEnergyInResults, AGGR_FIELDS.ACTIVE_ENERGY_IN)
  const dailyUteEnergy = processEnergyData(uteEnergyResults, AGGR_FIELDS.UTE_ENERGY)
  const nominalPowerMW = extractNominalPower(globalConfigResults)

  const allDays = new Set([
    ...Object.keys(dailyConsumption),
    ...Object.keys(dailyTransactions)
  ])

  const log = []
  for (const dayTs of [...allDays].sort()) {
    const ts = Number(dayTs)
    const transactions = dailyTransactions[dayTs] || {}
    const btcPrice = dailyPrices[dayTs] || currentBtcPrice || 0

    const powerW = dailyConsumption[dayTs] || 0
    const powerMWh = (powerW * 24) / 1000000
    const sitePowerMW = powerW / 1000000
    const revenueBTC = transactions.revenueBTC || 0
    const revenueUSD = revenueBTC * btcPrice

    const monthKey = getMonthKeyUtc(ts)
    const costs = costsByMonth[monthKey] || {}
    const energyCostUSD = resolveEnergyCostsUSD(costs, powerMWh, resolveLcoeUsdPerMwh(costParameters, monthKey))
    const totalCostUSD = energyCostUSD + (costs.operationalCostPerDay || 0)

    const activeEnergyIn = dailyActiveEnergyIn[dayTs] || 0
    const uteEnergy = dailyUteEnergy[dayTs] || 0
    const consumptionMWh = powerMWh

    const curtailmentMWh = activeEnergyIn > 0
      ? activeEnergyIn - consumptionMWh
      : null
    const curtailmentRate = curtailmentMWh !== null
      ? safeDiv(curtailmentMWh, consumptionMWh)
      : null

    const operationalIssuesRate = uteEnergy > 0
      ? safeDiv(uteEnergy - consumptionMWh, uteEnergy)
      : null

    const actualPowerMW = powerW / 1000000
    const powerUtilization = nominalPowerMW > 0
      ? safeDiv(actualPowerMW, nominalPowerMW)
      : null

    log.push({
      ts,
      powerW,
      sitePowerMW,
      consumptionMWh,
      revenueBTC,
      revenueUSD,
      btcPrice,
      energyCostUSD,
      totalCostUSD,
      energyRevenuePerMWh: safeDiv(revenueUSD, powerMWh),
      allInCostPerMWh: safeDiv(totalCostUSD, powerMWh),
      profitUSD: revenueUSD - totalCostUSD,
      curtailmentMWh,
      curtailmentRate,
      operationalIssuesRate,
      powerUtilization
    })
  }

  const aggregated = aggregateByPeriod(log, period, [], {
    meanKeys: [
      'sitePowerMW', 'powerW', 'btcPrice', 'energyRevenuePerMWh', 'allInCostPerMWh',
      'curtailmentRate', 'operationalIssuesRate', 'powerUtilization'
    ]
  })

  for (const entry of aggregated) {
    entry.energyRevenueBTC_MW = entry.sitePowerMW > 0 ? entry.revenueBTC / entry.sitePowerMW : 0
    entry.energyRevenueUSD_MW = entry.sitePowerMW > 0 ? entry.revenueUSD / entry.sitePowerMW : 0
  }
  aggregated.sort((a, b) => Number(a.ts) - Number(b.ts))

  const summary = calculateSummary(aggregated)

  return { log: aggregated, summary }
}

function processPriceData (results) {
  const daily = {}
  for (const res of results) {
    if (res.error || !res) continue
    const data = Array.isArray(res) ? res : (res.data || res.result || [])
    if (!Array.isArray(data)) continue
    for (const entry of data) {
      if (!entry) continue
      const rawTs = entry.ts || entry.timestamp || entry.time
      const ts = getStartOfDay(normalizeTimestampMs(rawTs))
      const price = entry.priceUSD || entry.price
      if (ts && price) {
        daily[ts] = price
      }
    }
  }
  return daily
}

// Both callers request stats-history with groupRange, so ts arrives as a range string rather
// than a number -- see parseEntryTs. getStartOfDay would divide that into NaN and every reading
// would be dropped by the guard below, leaving curtailment and operational issues with no data
// at all rather than a wrong value.
function processEnergyData (results, aggrField) {
  const daily = {}
  for (const res of results) {
    if (!res || res.error) continue
    const data = Array.isArray(res) ? res : (res.data || res.result || [])
    if (!Array.isArray(data)) continue
    for (const entry of data) {
      if (!entry) continue
      const items = Array.isArray(entry) ? entry : (entry.data || entry)
      if (Array.isArray(items)) {
        for (const item of items) {
          if (!item) continue
          const ts = getStartOfDay(parseEntryTs(item.ts || item.timestamp))
          if (!ts) continue
          const energyAggr = item[AGGR_FIELDS.ENERGY_AGGR]
          if (energyAggr && energyAggr[aggrField]) {
            daily[ts] = (daily[ts] || 0) + Number(energyAggr[aggrField])
          }
        }
      }
    }
  }
  return daily
}

function extractNominalPower (results) {
  for (const res of results) {
    if (!res || res.error) continue
    const data = Array.isArray(res) ? res : [res]
    for (const entry of data) {
      if (!entry) continue
      if (entry.nominalPowerAvailability_MW) return entry.nominalPowerAvailability_MW
    }
  }
  return 0
}

function calculateSummary (log) {
  if (!log.length) {
    return {
      totalRevenueBTC: 0,
      totalRevenueUSD: 0,
      totalCostUSD: 0,
      totalProfitUSD: 0,
      avgCostPerMWh: null,
      avgEnergyCostPerMWh: null,
      avgOperationalCostPerMWh: null,
      avgRevenuePerMWh: null,
      avgPowerConsumption: 0,
      totalConsumptionMWh: 0,
      avgCurtailmentRate: null,
      avgOperationalIssuesRate: null,
      avgPowerUtilization: null
    }
  }

  const totals = log.reduce((acc, entry) => {
    acc.revenueBTC += entry.revenueBTC || 0
    acc.revenueUSD += entry.revenueUSD || 0
    acc.energyCostUSD += entry.energyCostUSD || 0
    acc.costUSD += entry.totalCostUSD || 0
    acc.profitUSD += entry.profitUSD || 0
    acc.consumptionMWh += entry.consumptionMWh || 0
    if (entry.sitePowerMW !== null && entry.sitePowerMW !== undefined) {
      acc.sitePowerMWSum += entry.sitePowerMW
      acc.sitePowerMWCount++
    }
    if (entry.curtailmentRate !== null && entry.curtailmentRate !== undefined) {
      acc.curtailmentRateSum += entry.curtailmentRate
      acc.curtailmentRateCount++
    }
    if (entry.operationalIssuesRate !== null && entry.operationalIssuesRate !== undefined) {
      acc.operationalIssuesRateSum += entry.operationalIssuesRate
      acc.operationalIssuesRateCount++
    }
    if (entry.powerUtilization !== null && entry.powerUtilization !== undefined) {
      acc.powerUtilizationSum += entry.powerUtilization
      acc.powerUtilizationCount++
    }
    return acc
  }, {
    revenueBTC: 0,
    revenueUSD: 0,
    energyCostUSD: 0,
    costUSD: 0,
    profitUSD: 0,
    consumptionMWh: 0,
    sitePowerMWSum: 0,
    sitePowerMWCount: 0,
    curtailmentRateSum: 0,
    curtailmentRateCount: 0,
    operationalIssuesRateSum: 0,
    operationalIssuesRateCount: 0,
    powerUtilizationSum: 0,
    powerUtilizationCount: 0
  })

  return {
    totalRevenueBTC: totals.revenueBTC,
    totalRevenueUSD: totals.revenueUSD,
    totalCostUSD: totals.costUSD,
    totalProfitUSD: totals.profitUSD,
    avgCostPerMWh: safeDiv(totals.costUSD, totals.consumptionMWh),
    avgEnergyCostPerMWh: safeDiv(totals.energyCostUSD, totals.consumptionMWh),
    avgOperationalCostPerMWh: safeDiv(totals.costUSD - totals.energyCostUSD, totals.consumptionMWh),
    avgRevenuePerMWh: safeDiv(totals.revenueUSD, totals.consumptionMWh),
    avgPowerConsumption: safeDiv(totals.sitePowerMWSum, totals.sitePowerMWCount),
    totalConsumptionMWh: totals.consumptionMWh,
    avgCurtailmentRate: safeDiv(totals.curtailmentRateSum, totals.curtailmentRateCount),
    avgOperationalIssuesRate: safeDiv(totals.operationalIssuesRateSum, totals.operationalIssuesRateCount),
    avgPowerUtilization: safeDiv(totals.powerUtilizationSum, totals.powerUtilizationCount)
  }
}

// ==================== EBITDA ====================

async function getEbitda (ctx, req) {
  const { start, end } = validateStartEnd(req)
  const period = req.query.period || PERIOD_TYPES.MONTHLY

  const [transactionResults, dailyPower, dailyHashrate, priceResults, currentPriceResults, productionCosts, costParameters] = await runParallel([
    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MINERPOOL,
      query: { key: MINERPOOL_EXT_DATA_KEYS.TRANSACTIONS, start, end }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => getDailySeries(ctx, start, end, getConsumption, 'powerW')
      .then(r => cb(null, r)).catch(cb),

    (cb) => getDailySeries(ctx, start, end, getHashrate, 'hashrateMhs')
      .then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'HISTORICAL_PRICES', start, end }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'current_price' }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => getProductionCosts(ctx, start, end)
      .then(r => cb(null, r)).catch(cb),

    (cb) => getCostParameters(ctx)
      .then(r => cb(null, r)).catch(cb)
  ])

  const dailyTransactions = processTransactions(transactionResults)
  const dailyPrices = processEbitdaPrices(priceResults)
  const currentBtcPrice = extractCurrentPrice(currentPriceResults)
  const costsByMonth = processCostsData(productionCosts)

  const allDays = new Set([
    ...Object.keys(dailyTransactions),
    ...Object.keys(dailyPower),
    ...Object.keys(dailyHashrate)
  ])

  const log = []
  for (const dayTs of [...allDays].sort()) {
    const ts = Number(dayTs)
    const transactions = dailyTransactions[dayTs] || {}
    const btcPrice = dailyPrices[dayTs] || currentBtcPrice || 0

    const revenueBTC = transactions.revenueBTC || 0
    const revenueUSD = revenueBTC * btcPrice
    const powerW = dailyPower[dayTs] || 0
    const hashrateMhs = dailyHashrate[dayTs] || 0
    const powerMWh = (powerW * 24) / 1000000

    const monthKey = getMonthKeyUtc(ts)
    const costs = costsByMonth[monthKey] || {}
    const energyCostsUSD = resolveEnergyCostsUSD(costs, powerMWh, resolveLcoeUsdPerMwh(costParameters, monthKey))
    const operationalCostsUSD = costs.operationalCostPerDay || 0
    const totalCostsUSD = energyCostsUSD + operationalCostsUSD

    const ebitdaSelling = revenueUSD - totalCostsUSD
    const ebitdaHodl = (revenueBTC * currentBtcPrice) - totalCostsUSD
    const btcProductionCost = safeDiv(totalCostsUSD, revenueBTC)

    log.push({
      ts,
      revenueBTC,
      revenueUSD,
      btcPrice,
      powerW,
      hashrateMhs,
      consumptionMWh: powerMWh,
      energyCostsUSD,
      operationalCostsUSD,
      totalCostsUSD,
      ebitdaSelling,
      ebitdaHodl,
      btcProductionCost
    })
  }

  const aggregated = aggregateByPeriod(log, period, [], {
    meanKeys: ['btcPrice', 'powerW', 'hashrateMhs', 'btcProductionCost']
  })
  const summary = calculateEbitdaSummary(aggregated, currentBtcPrice)

  return { log: aggregated, summary }
}

function processEbitdaPrices (results) {
  const daily = {}
  for (const res of results) {
    if (res.error || !res) continue
    const data = Array.isArray(res) ? res : (res.data || res.result || [])
    if (!Array.isArray(data)) continue
    for (const entry of data) {
      if (!entry) continue
      const rawTs = entry.ts || entry.timestamp || entry.time
      const items = rawTs ? [entry] : (entry.data || entry.prices || entry)
      if (Array.isArray(items)) {
        for (const item of items) {
          const ts = getStartOfDay(item.ts || item.timestamp || item.time)
          const price = item.priceUSD || item.price
          if (ts && price) {
            daily[ts] = price
          }
        }
      } else if (typeof items === 'object') {
        for (const [key, val] of Object.entries(items)) {
          const ts = getStartOfDay(Number(key))
          if (ts) {
            daily[ts] = typeof val === 'object' ? (val.USD || val.priceUSD || val.price || 0) : Number(val) || 0
          }
        }
      }
    }
  }
  return daily
}

function calculateEbitdaSummary (log, currentBtcPrice) {
  if (!log.length) {
    return {
      totalRevenueBTC: 0,
      totalRevenueUSD: 0,
      totalCostsUSD: 0,
      totalEbitdaSelling: 0,
      totalEbitdaHodl: 0,
      avgBtcProductionCost: null,
      currentBtcPrice: currentBtcPrice || 0
    }
  }

  const totals = log.reduce((acc, entry) => {
    acc.revenueBTC += entry.revenueBTC || 0
    acc.revenueUSD += entry.revenueUSD || 0
    acc.costsUSD += entry.totalCostsUSD || 0
    acc.ebitdaSelling += entry.ebitdaSelling || 0
    acc.ebitdaHodl += entry.ebitdaHodl || 0
    return acc
  }, { revenueBTC: 0, revenueUSD: 0, costsUSD: 0, ebitdaSelling: 0, ebitdaHodl: 0 })

  return {
    totalRevenueBTC: totals.revenueBTC,
    totalRevenueUSD: totals.revenueUSD,
    totalCostsUSD: totals.costsUSD,
    totalEbitdaSelling: totals.ebitdaSelling,
    totalEbitdaHodl: totals.ebitdaHodl,
    avgBtcProductionCost: safeDiv(totals.costsUSD, totals.revenueBTC),
    currentBtcPrice: currentBtcPrice || 0
  }
}

// ==================== Cost Summary ====================

async function getCostSummary (ctx, req) {
  const { start, end } = validateStartEnd(req)
  const period = req.query.period || PERIOD_TYPES.MONTHLY

  const [productionCosts, priceResults, dailyConsumption, costParameters] = await runParallel([
    (cb) => getProductionCosts(ctx, start, end)
      .then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'HISTORICAL_PRICES', start, end }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => getDailySeries(ctx, start, end, getConsumption, 'powerW')
      .then(r => cb(null, r)).catch(cb),

    (cb) => getCostParameters(ctx)
      .then(r => cb(null, r)).catch(cb)
  ])

  const costsByMonth = processCostsData(productionCosts)
  const dailyPrices = processEbitdaPrices(priceResults)

  const allDays = new Set([
    ...Object.keys(dailyConsumption),
    ...Object.keys(dailyPrices)
  ])

  const log = []
  for (const dayTs of [...allDays].sort()) {
    const ts = Number(dayTs)
    const btcPrice = dailyPrices[dayTs] || 0

    const powerW = dailyConsumption[dayTs] || 0
    const consumptionMWh = (powerW * 24) / 1000000

    const monthKey = getMonthKeyUtc(ts)
    const costs = costsByMonth[monthKey] || {}
    const energyCostsUSD = resolveEnergyCostsUSD(costs, consumptionMWh, resolveLcoeUsdPerMwh(costParameters, monthKey))
    const operationalCostsUSD = costs.operationalCostPerDay || 0
    const totalCostsUSD = energyCostsUSD + operationalCostsUSD

    log.push({
      ts,
      consumptionMWh,
      energyCostsUSD,
      operationalCostsUSD,
      totalCostsUSD,
      allInCostPerMWh: safeDiv(totalCostsUSD, consumptionMWh),
      energyCostPerMWh: safeDiv(energyCostsUSD, consumptionMWh),
      btcPrice
    })
  }

  const aggregated = aggregateByPeriod(log, period, [], {
    meanKeys: ['btcPrice', 'allInCostPerMWh', 'energyCostPerMWh']
  })
  const summary = calculateCostSummary(aggregated)

  return { log: aggregated, summary }
}

function calculateCostSummary (log) {
  if (!log.length) {
    return {
      totalEnergyCostsUSD: 0,
      totalOperationalCostsUSD: 0,
      totalCostsUSD: 0,
      totalConsumptionMWh: 0,
      avgAllInCostPerMWh: null,
      avgEnergyCostPerMWh: null,
      avgBtcPrice: null
    }
  }

  const totals = log.reduce((acc, entry) => {
    acc.energyCosts += entry.energyCostsUSD || 0
    acc.operationalCosts += entry.operationalCostsUSD || 0
    acc.totalCosts += entry.totalCostsUSD || 0
    acc.consumption += entry.consumptionMWh || 0
    acc.btcPriceSum += entry.btcPrice || 0
    acc.btcPriceCount += entry.btcPrice ? 1 : 0
    return acc
  }, { energyCosts: 0, operationalCosts: 0, totalCosts: 0, consumption: 0, btcPriceSum: 0, btcPriceCount: 0 })

  return {
    totalEnergyCostsUSD: totals.energyCosts,
    totalOperationalCostsUSD: totals.operationalCosts,
    totalCostsUSD: totals.totalCosts,
    totalConsumptionMWh: totals.consumption,
    avgAllInCostPerMWh: safeDiv(totals.totalCosts, totals.consumption),
    avgEnergyCostPerMWh: safeDiv(totals.energyCosts, totals.consumption),
    avgBtcPrice: safeDiv(totals.btcPriceSum, totals.btcPriceCount)
  }
}

// ==================== Subsidy Fees ====================

async function getSubsidyFees (ctx, req) {
  const { start, end } = validateStartEnd(req)
  const period = req.query.period || PERIOD_TYPES.DAILY

  const blockResults = await ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
    type: WORKER_TYPES.MEMPOOL,
    query: { key: 'HISTORICAL_BLOCKSIZES', start, end }
  })

  const dailyBlocks = processBlockData(blockResults)

  const log = []
  for (const dayTs of Object.keys(dailyBlocks).sort()) {
    const ts = Number(dayTs)
    const block = dailyBlocks[dayTs]
    log.push({
      ts,
      blockReward: block.blockReward,
      blockTotalFees: block.blockTotalFees,
      blockSize: block.blockSize
    })
  }

  const aggregated = aggregateByPeriod(log, period)
  const summary = calculateSubsidyFeesSummary(aggregated)

  return { log: aggregated, summary }
}

function calculateSubsidyFeesSummary (log) {
  if (!log.length) {
    return {
      totalBlockReward: 0,
      totalBlockTotalFees: 0,
      totalBlockSize: 0,
      avgBlockReward: null,
      avgBlockTotalFees: null,
      avgBlockSize: null
    }
  }

  const totals = log.reduce((acc, entry) => {
    acc.blockReward += entry.blockReward || 0
    acc.blockTotalFees += entry.blockTotalFees || 0
    acc.blockSize += entry.blockSize || 0
    return acc
  }, { blockReward: 0, blockTotalFees: 0, blockSize: 0 })

  return {
    totalBlockReward: totals.blockReward,
    totalBlockTotalFees: totals.blockTotalFees,
    totalBlockSize: totals.blockSize,
    avgBlockReward: safeDiv(totals.blockReward, log.length),
    avgBlockTotalFees: safeDiv(totals.blockTotalFees, log.length),
    avgBlockSize: safeDiv(totals.blockSize, log.length)
  }
}

// ==================== Revenue ====================

async function getRevenue (ctx, req) {
  const { start, end } = validateStartEnd(req)
  const period = req.query.period || PERIOD_TYPES.DAILY
  const pool = req.query.pool || null

  const type = pool ? WORKER_TYPES.MINERPOOL + '-' + pool : WORKER_TYPES.MINERPOOL
  const query = { key: MINERPOOL_EXT_DATA_KEYS.TRANSACTIONS, start, end }

  const transactionResults = await ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
    type,
    query
  })

  const dailyRevenue = processTransactions(transactionResults, { trackFees: true })

  const log = []
  for (const dayTs of Object.keys(dailyRevenue).sort()) {
    const ts = Number(dayTs)
    const day = dailyRevenue[dayTs]
    const revenueBTC = day.revenueBTC || 0
    const feesBTC = day.feesBTC || 0
    log.push({
      ts,
      revenueBTC,
      feesBTC,
      netRevenueBTC: revenueBTC - feesBTC
    })
  }

  const aggregated = aggregateByPeriod(log, period)
  const summary = calculateRevenueSummary(aggregated)

  return { log: aggregated, summary }
}

function calculateRevenueSummary (log) {
  if (!log.length) {
    return {
      totalRevenueBTC: 0,
      totalFeesBTC: 0,
      totalNetRevenueBTC: 0
    }
  }

  const totals = log.reduce((acc, entry) => {
    acc.revenueBTC += entry.revenueBTC || 0
    acc.feesBTC += entry.feesBTC || 0
    acc.netRevenueBTC += entry.netRevenueBTC || 0
    return acc
  }, { revenueBTC: 0, feesBTC: 0, netRevenueBTC: 0 })

  return {
    totalRevenueBTC: totals.revenueBTC,
    totalFeesBTC: totals.feesBTC,
    totalNetRevenueBTC: totals.netRevenueBTC
  }
}

// ==================== Revenue Hourly ====================

// Hourly pool revenue estimates. The minerpool worker's _aggrTransactions
// produces hourlyRevenues (BTC per hour) when queried with aggrHourly; this
// exposes it directly rather than fanning the tail-log call out on the client.
async function getRevenueHourly (ctx, req) {
  const { start, end } = validateStartEnd(req)
  const pool = req.query.pool || null

  const type = pool ? WORKER_TYPES.MINERPOOL + '-' + pool : WORKER_TYPES.MINERPOOL

  const results = await ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
    type,
    query: { key: MINERPOOL_EXT_DATA_KEYS.TRANSACTIONS, start, end, aggrHourly: 1 }
  })

  const log = processHourlyRevenues(results)
  const summary = calculateHourlyRevenueSummary(log)

  return { log, summary }
}

function processHourlyRevenues (results) {
  const byHour = {}
  for (const res of results) {
    if (!res || res.error) continue
    const items = Array.isArray(res) ? res : [res]
    for (const item of items) {
      const hourly = item && item.hourlyRevenues
      if (!Array.isArray(hourly)) continue
      for (const bucket of hourly) {
        if (!bucket || bucket.ts == null) continue
        byHour[bucket.ts] = (byHour[bucket.ts] || 0) + (Number(bucket.revenue) || 0)
      }
    }
  }

  return Object.keys(byHour)
    .sort((a, b) => a - b)
    .map(ts => ({ ts: Number(ts), revenueBTC: byHour[ts] }))
}

function calculateHourlyRevenueSummary (log) {
  const totalRevenueBTC = log.reduce((sum, entry) => sum + (entry.revenueBTC || 0), 0)
  return { totalRevenueBTC }
}

// ==================== Revenue Summary ====================

async function getRevenueSummary (ctx, req) {
  const { start, end } = validateStartEnd(req)
  const period = req.query.period || PERIOD_TYPES.DAILY

  const [
    transactionResults,
    priceResults,
    currentPriceResults,
    dailyPower,
    dailyHashrate,
    productionCosts,
    blockResults,
    activeEnergyInResults,
    uteEnergyResults,
    globalConfigResults,
    costParameters
  ] = await runParallel([
    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MINERPOOL,
      query: { key: MINERPOOL_EXT_DATA_KEYS.TRANSACTIONS, start, end }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'HISTORICAL_PRICES', start, end }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'current_price' }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => getDailySeries(ctx, start, end, getConsumption, 'powerW')
      .then(r => cb(null, r)).catch(cb),

    (cb) => getDailySeries(ctx, start, end, getHashrate, 'hashrateMhs')
      .then(r => cb(null, r)).catch(cb),

    (cb) => getProductionCosts(ctx, start, end)
      .then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'HISTORICAL_BLOCKSIZES', start, end }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.ELECTRICITY,
      query: { key: 'stats-history', start, end, groupRange: '1D' }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.ELECTRICITY,
      query: { key: 'stats-history', start, end, groupRange: '1D' }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GLOBAL_CONFIG, {})
      .then(r => cb(null, r)).catch(cb),

    (cb) => getCostParameters(ctx)
      .then(r => cb(null, r)).catch(cb)
  ])

  const dailyRevenue = processTransactions(transactionResults, { trackFees: true })
  const dailyPrices = processEbitdaPrices(priceResults)
  const currentBtcPrice = extractCurrentPrice(currentPriceResults)
  const costsByMonth = processCostsData(productionCosts)
  const dailyBlocks = processBlockData(blockResults)
  const dailyActiveEnergyIn = processEnergyData(activeEnergyInResults, AGGR_FIELDS.ACTIVE_ENERGY_IN)
  const dailyUteEnergy = processEnergyData(uteEnergyResults, AGGR_FIELDS.UTE_ENERGY)
  const nominalPowerMW = extractNominalPower(globalConfigResults)

  const allDays = new Set([
    ...Object.keys(dailyRevenue),
    ...Object.keys(dailyPower),
    ...Object.keys(dailyHashrate),
    ...Object.keys(dailyPrices)
  ])

  const log = []
  for (const dayTs of [...allDays].sort()) {
    const ts = Number(dayTs)
    const revenue = dailyRevenue[dayTs] || {}
    const btcPrice = dailyPrices[dayTs] || currentBtcPrice || 0
    const block = dailyBlocks[dayTs] || {}

    const revenueBTC = revenue.revenueBTC || 0
    const feesBTC = revenue.feesBTC || 0
    const revenueUSD = revenueBTC * btcPrice
    const feesUSD = feesBTC * btcPrice

    const powerW = dailyPower[dayTs] || 0
    const consumptionMWh = (powerW * 24) / 1000000
    const hashrateMhs = dailyHashrate[dayTs] || 0
    const hashratePhs = hashrateMhs / 1e9

    const monthKey = getMonthKeyUtc(ts)
    const costs = costsByMonth[monthKey] || {}
    const energyCostsUSD = resolveEnergyCostsUSD(costs, consumptionMWh, resolveLcoeUsdPerMwh(costParameters, monthKey))
    const operationalCostsUSD = costs.operationalCostPerDay || 0
    const totalCostsUSD = energyCostsUSD + operationalCostsUSD

    const activeEnergyIn = dailyActiveEnergyIn[dayTs] || 0
    const uteEnergy = dailyUteEnergy[dayTs] || 0

    const curtailmentMWh = activeEnergyIn > 0
      ? activeEnergyIn - consumptionMWh
      : null
    const curtailmentRate = curtailmentMWh !== null
      ? safeDiv(curtailmentMWh, consumptionMWh)
      : null

    const operationalIssuesRate = uteEnergy > 0
      ? safeDiv(uteEnergy - consumptionMWh, uteEnergy)
      : null

    const actualPowerMW = powerW / 1000000
    const powerUtilization = nominalPowerMW > 0
      ? safeDiv(actualPowerMW, nominalPowerMW)
      : null

    log.push({
      ts,
      revenueBTC,
      feesBTC,
      revenueUSD,
      feesUSD,
      btcPrice,
      powerW,
      consumptionMWh,
      hashrateMhs,
      energyCostsUSD,
      operationalCostsUSD,
      totalCostsUSD,
      ebitdaSelling: revenueUSD - totalCostsUSD,
      ebitdaHodl: (revenueBTC * currentBtcPrice) - totalCostsUSD,
      btcProductionCost: safeDiv(totalCostsUSD, revenueBTC),
      energyRevenuePerMWh: safeDiv(revenueUSD, consumptionMWh),
      allInCostPerMWh: safeDiv(totalCostsUSD, consumptionMWh),
      hashRevenueBTCPerPHsPerDay: safeDiv(revenueBTC, hashratePhs),
      hashRevenueUSDPerPHsPerDay: safeDiv(revenueUSD, hashratePhs),
      blockReward: block.blockReward || 0,
      blockTotalFees: block.blockTotalFees || 0,
      blockSize: block.blockSize || 0,
      curtailmentMWh,
      curtailmentRate,
      operationalIssuesRate,
      powerUtilization
    })
  }

  const aggregated = aggregateByPeriod(log, period, [], {
    meanKeys: [
      'btcPrice', 'powerW', 'hashrateMhs', 'btcProductionCost', 'energyRevenuePerMWh', 'allInCostPerMWh',
      'hashRevenueBTCPerPHsPerDay', 'hashRevenueUSDPerPHsPerDay',
      'curtailmentRate', 'operationalIssuesRate', 'powerUtilization'
    ]
  })
  const summary = calculateDetailedRevenueSummary(aggregated, currentBtcPrice)

  return { log: aggregated, summary }
}

function calculateDetailedRevenueSummary (log, currentBtcPrice) {
  if (!log.length) {
    return {
      totalRevenueBTC: 0,
      totalRevenueUSD: 0,
      totalFeesBTC: 0,
      totalFeesUSD: 0,
      totalCostsUSD: 0,
      totalConsumptionMWh: 0,
      avgCostPerMWh: null,
      avgRevenuePerMWh: null,
      avgBtcPrice: null,
      avgCurtailmentRate: null,
      avgPowerUtilization: null,
      totalEbitdaSelling: 0,
      totalEbitdaHodl: 0,
      currentBtcPrice: currentBtcPrice || 0
    }
  }

  const totals = log.reduce((acc, entry) => {
    acc.revenueBTC += entry.revenueBTC || 0
    acc.revenueUSD += entry.revenueUSD || 0
    acc.feesBTC += entry.feesBTC || 0
    acc.feesUSD += entry.feesUSD || 0
    acc.costsUSD += entry.totalCostsUSD || 0
    acc.consumptionMWh += entry.consumptionMWh || 0
    acc.ebitdaSelling += entry.ebitdaSelling || 0
    acc.ebitdaHodl += entry.ebitdaHodl || 0
    acc.btcPriceSum += entry.btcPrice || 0
    acc.btcPriceCount += entry.btcPrice ? 1 : 0
    if (entry.curtailmentRate !== null && entry.curtailmentRate !== undefined) {
      acc.curtailmentRateSum += entry.curtailmentRate
      acc.curtailmentRateCount++
    }
    if (entry.powerUtilization !== null && entry.powerUtilization !== undefined) {
      acc.powerUtilizationSum += entry.powerUtilization
      acc.powerUtilizationCount++
    }
    return acc
  }, {
    revenueBTC: 0,
    revenueUSD: 0,
    feesBTC: 0,
    feesUSD: 0,
    costsUSD: 0,
    consumptionMWh: 0,
    ebitdaSelling: 0,
    ebitdaHodl: 0,
    btcPriceSum: 0,
    btcPriceCount: 0,
    curtailmentRateSum: 0,
    curtailmentRateCount: 0,
    powerUtilizationSum: 0,
    powerUtilizationCount: 0
  })

  return {
    totalRevenueBTC: totals.revenueBTC,
    totalRevenueUSD: totals.revenueUSD,
    totalFeesBTC: totals.feesBTC,
    totalFeesUSD: totals.feesUSD,
    totalCostsUSD: totals.costsUSD,
    totalConsumptionMWh: totals.consumptionMWh,
    avgCostPerMWh: safeDiv(totals.costsUSD, totals.consumptionMWh),
    avgRevenuePerMWh: safeDiv(totals.revenueUSD, totals.consumptionMWh),
    avgBtcPrice: safeDiv(totals.btcPriceSum, totals.btcPriceCount),
    avgCurtailmentRate: safeDiv(totals.curtailmentRateSum, totals.curtailmentRateCount),
    avgPowerUtilization: safeDiv(totals.powerUtilizationSum, totals.powerUtilizationCount),
    totalEbitdaSelling: totals.ebitdaSelling,
    totalEbitdaHodl: totals.ebitdaHodl,
    currentBtcPrice: currentBtcPrice || 0
  }
}

// ==================== Hash Revenue ====================

async function getHashRevenue (ctx, req) {
  const { start, end } = validateStartEnd(req)
  const period = req.query.period || PERIOD_TYPES.DAILY

  const [
    transactionResults,
    dailyHashrate,
    priceResults,
    currentPriceResults,
    networkHashrateResults
  ] = await runParallel([
    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MINERPOOL,
      query: { key: MINERPOOL_EXT_DATA_KEYS.TRANSACTIONS, start, end }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => getDailySeries(ctx, start, end, getHashrate, 'hashrateMhs')
      .then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'HISTORICAL_PRICES', start, end }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'current_price' }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'HISTORICAL_HASHRATE', start, end }
    }).then(r => cb(null, r)).catch(cb)
  ])

  const dailyTransactions = processTransactions(transactionResults, { trackFees: true })
  const dailyPrices = processEbitdaPrices(priceResults)
  const currentBtcPrice = extractCurrentPrice(currentPriceResults)
  const dailyNetworkHashrate = processNetworkHashrateData(networkHashrateResults)

  const allDays = new Set([
    ...Object.keys(dailyTransactions),
    ...Object.keys(dailyHashrate)
  ])

  const log = []
  for (const dayTs of [...allDays].sort()) {
    const ts = Number(dayTs)
    const transactions = dailyTransactions[dayTs] || {}
    const btcPrice = dailyPrices[dayTs] || currentBtcPrice || 0

    const revenueBTC = transactions.revenueBTC || 0
    const feesBTC = transactions.feesBTC || 0
    const revenueUSD = revenueBTC * btcPrice
    const feesUSD = feesBTC * btcPrice
    const hashrateMhs = dailyHashrate[dayTs] || 0
    const hashratePhs = hashrateMhs / 1e9
    const networkHashrateMhs = dailyNetworkHashrate[dayTs] || 0
    const networkHashratePhs = networkHashrateMhs / 1e9

    log.push({
      ts,
      revenueBTC,
      feesBTC,
      revenueUSD,
      feesUSD,
      btcPrice,
      hashrateMhs,
      hashRevenueBTCPerPHsPerDay: safeDiv(revenueBTC, hashratePhs),
      hashRevenueUSDPerPHsPerDay: safeDiv(revenueUSD, hashratePhs),
      hashCostBTCPerPHsPerDay: safeDiv(feesBTC, hashratePhs),
      hashCostUSDPerPHsPerDay: safeDiv(feesUSD, hashratePhs),
      networkHashPriceBTCPerPHsPerDay: safeDiv(revenueBTC, networkHashratePhs),
      networkHashPriceUSDPerPHsPerDay: safeDiv(revenueUSD, networkHashratePhs),
      networkHashrateMhs
    })
  }

  const aggregated = aggregateByPeriod(log, period, [], {
    meanKeys: [
      'btcPrice', 'hashrateMhs', 'networkHashrateMhs',
      'hashRevenueBTCPerPHsPerDay', 'hashRevenueUSDPerPHsPerDay', 'hashCostBTCPerPHsPerDay', 'hashCostUSDPerPHsPerDay',
      'networkHashPriceBTCPerPHsPerDay', 'networkHashPriceUSDPerPHsPerDay'
    ]
  })
  const summary = calculateHashRevenueSummary(aggregated)

  return { log: aggregated, summary }
}

function processNetworkHashrateData (results) {
  const daily = {}
  for (const res of results) {
    if (!res || res.error) continue
    const data = Array.isArray(res) ? res : (res.data || res.result || [])
    if (!Array.isArray(data)) continue
    for (const entry of data) {
      if (!entry) continue
      const rawTs = entry.ts || entry.timestamp || entry.time
      const items = rawTs ? [entry] : (entry.data || entry)
      if (Array.isArray(items)) {
        for (const item of items) {
          if (!item) continue
          const itemTs = item.ts || item.timestamp || item.time
          const ts = getStartOfDay(normalizeTimestampMs(itemTs))
          if (!ts) continue
          if (item.avgHashrateMHs) {
            daily[ts] = item.avgHashrateMHs
          }
        }
      } else if (typeof items === 'object') {
        for (const [key, val] of Object.entries(items)) {
          const ts = getStartOfDay(Number(key))
          if (!ts) continue
          if (typeof val === 'object' && val.avgHashrateMHs) {
            daily[ts] = val.avgHashrateMHs
          } else if (typeof val === 'number') {
            daily[ts] = val
          }
        }
      }
    }
  }
  return daily
}

function calculateHashRevenueSummary (log) {
  if (!log.length) {
    return {
      avgHashRevenueBTCPerPHsPerDay: null,
      avgHashRevenueUSDPerPHsPerDay: null,
      avgHashCostBTCPerPHsPerDay: null,
      avgHashCostUSDPerPHsPerDay: null,
      avgNetworkHashPriceBTCPerPHsPerDay: null,
      avgNetworkHashPriceUSDPerPHsPerDay: null,
      totalRevenueBTC: 0,
      totalRevenueUSD: 0,
      totalFeesBTC: 0,
      totalFeesUSD: 0
    }
  }

  const totals = log.reduce((acc, entry) => {
    acc.revenueBTC += entry.revenueBTC || 0
    acc.revenueUSD += entry.revenueUSD || 0
    acc.feesBTC += entry.feesBTC || 0
    acc.feesUSD += entry.feesUSD || 0
    if (entry.hashRevenueBTCPerPHsPerDay !== null && entry.hashRevenueBTCPerPHsPerDay !== undefined) {
      acc.hashRevBTCSum += entry.hashRevenueBTCPerPHsPerDay
      acc.hashRevBTCCount++
    }
    if (entry.hashRevenueUSDPerPHsPerDay !== null && entry.hashRevenueUSDPerPHsPerDay !== undefined) {
      acc.hashRevUSDSum += entry.hashRevenueUSDPerPHsPerDay
      acc.hashRevUSDCount++
    }
    if (entry.hashCostBTCPerPHsPerDay !== null && entry.hashCostBTCPerPHsPerDay !== undefined) {
      acc.hashCostBTCSum += entry.hashCostBTCPerPHsPerDay
      acc.hashCostBTCCount++
    }
    if (entry.hashCostUSDPerPHsPerDay !== null && entry.hashCostUSDPerPHsPerDay !== undefined) {
      acc.hashCostUSDSum += entry.hashCostUSDPerPHsPerDay
      acc.hashCostUSDCount++
    }
    if (entry.networkHashPriceBTCPerPHsPerDay !== null && entry.networkHashPriceBTCPerPHsPerDay !== undefined) {
      acc.netHashBTCSum += entry.networkHashPriceBTCPerPHsPerDay
      acc.netHashBTCCount++
    }
    if (entry.networkHashPriceUSDPerPHsPerDay !== null && entry.networkHashPriceUSDPerPHsPerDay !== undefined) {
      acc.netHashUSDSum += entry.networkHashPriceUSDPerPHsPerDay
      acc.netHashUSDCount++
    }
    return acc
  }, {
    revenueBTC: 0,
    revenueUSD: 0,
    feesBTC: 0,
    feesUSD: 0,
    hashRevBTCSum: 0,
    hashRevBTCCount: 0,
    hashRevUSDSum: 0,
    hashRevUSDCount: 0,
    hashCostBTCSum: 0,
    hashCostBTCCount: 0,
    hashCostUSDSum: 0,
    hashCostUSDCount: 0,
    netHashBTCSum: 0,
    netHashBTCCount: 0,
    netHashUSDSum: 0,
    netHashUSDCount: 0
  })

  return {
    avgHashRevenueBTCPerPHsPerDay: safeDiv(totals.hashRevBTCSum, totals.hashRevBTCCount),
    avgHashRevenueUSDPerPHsPerDay: safeDiv(totals.hashRevUSDSum, totals.hashRevUSDCount),
    avgHashCostBTCPerPHsPerDay: safeDiv(totals.hashCostBTCSum, totals.hashCostBTCCount),
    avgHashCostUSDPerPHsPerDay: safeDiv(totals.hashCostUSDSum, totals.hashCostUSDCount),
    avgNetworkHashPriceBTCPerPHsPerDay: safeDiv(totals.netHashBTCSum, totals.netHashBTCCount),
    avgNetworkHashPriceUSDPerPHsPerDay: safeDiv(totals.netHashUSDSum, totals.netHashUSDCount),
    totalRevenueBTC: totals.revenueBTC,
    totalRevenueUSD: totals.revenueUSD,
    totalFeesBTC: totals.feesBTC,
    totalFeesUSD: totals.feesUSD
  }
}

// ==================== Shared ====================

// ==================== Avg All-in Power Cost ====================

const WATTS_PER_MW = 1e6
const HOURS_PER_DAY = 24

// Day timestamps are on the UTC grid, and costsByMonth / costParameters.overrides are keyed by
// calendar month, so the key has to be derived in UTC too - local getters move a UTC midnight
// into the previous month on any host west of UTC.
function getMonthKeyUtc (ts) {
  const date = new Date(ts)
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function getStartOfMonthUtc (ts) {
  const date = new Date(ts)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}

async function getPowerCost (ctx, req) {
  const { start, end } = validateStartEnd(req)
  const startMonthTs = getStartOfMonthUtc(start)
  const endMonthTs = getStartOfMonthUtc(end)

  const [
    dailyAvgPowerW,
    transactionResults,
    priceResults,
    productionCosts
  ] = await runParallel([
    (cb) => getDailySeries(ctx, start, end, getConsumption, 'powerW')
      .then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MINERPOOL,
      query: { key: MINERPOOL_EXT_DATA_KEYS.TRANSACTIONS, start, end }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'HISTORICAL_PRICES', start, end }
    }).then(r => cb(null, r)).catch(cb),

    // Widened by a day on each side because getProductionCosts compares
    // local-time month starts; the month filter below is the precise one.
    (cb) => getProductionCosts(ctx, startMonthTs - METRICS_TIME.ONE_DAY_MS, end + METRICS_TIME.ONE_DAY_MS)
      .then(r => cb(null, r)).catch(cb)
  ])

  const dailyRevenueBTC = processDailyRevenueBtc(transactionResults, start, end)
  const dailyAvgPrices = processDailyAvgPrices(priceResults, start, end)
  const costsByMonth = sumCostsByMonth(productionCosts, startMonthTs, endMonthTs)

  const monthly = {}
  const monthBucket = (monthTs) => {
    if (!monthly[monthTs]) monthly[monthTs] = { revenueUSD: 0, mWh: 0, costUSD: 0 }
    return monthly[monthTs]
  }

  // Revenue only counts on days that also have a BTC price; a priceless day
  // would otherwise be valued at 0 and drag the monthly average down.
  for (const [dayTs, revenueBTC] of Object.entries(dailyRevenueBTC)) {
    const price = dailyAvgPrices[dayTs]
    if (!Number.isFinite(price)) continue
    monthBucket(getStartOfMonthUtc(Number(dayTs))).revenueUSD += revenueBTC * price
  }

  const dailyAvgWByMonth = {}
  for (const [dayTs, avgW] of Object.entries(dailyAvgPowerW)) {
    const monthTs = getStartOfMonthUtc(Number(dayTs))
    if (!dailyAvgWByMonth[monthTs]) dailyAvgWByMonth[monthTs] = []
    dailyAvgWByMonth[monthTs].push(avgW)
  }
  for (const [monthTs, dailyAvgW] of Object.entries(dailyAvgWByMonth)) {
    const meanW = dailyAvgW.reduce((sum, w) => sum + w, 0) / dailyAvgW.length
    monthBucket(Number(monthTs)).mWh = (meanW / WATTS_PER_MW) * HOURS_PER_DAY * dailyAvgW.length
  }

  for (const [monthTs, costUSD] of Object.entries(costsByMonth)) {
    monthBucket(Number(monthTs)).costUSD = costUSD
  }

  const log = Object.entries(monthly)
    .map(([monthTs, { revenueUSD, mWh, costUSD }]) => ({
      ts: Number(monthTs),
      revenueUSD: mWh > 0 ? revenueUSD / mWh : 0,
      hashCostUSD: mWh > 0 ? costUSD / mWh : 0
    }))
    .filter(({ ts }) => ts >= startMonthTs && ts <= endMonthTs)
    .sort((a, b) => a.ts - b.ts)

  return { log }
}

function processDailyRevenueBtc (results, start, end) {
  const startDay = getStartOfDay(start)
  const endDay = getStartOfDay(end)
  const daily = {}
  for (const res of results) {
    if (!res || res.error) continue
    const data = Array.isArray(res) ? res : (res.data || res.result || [])
    if (!Array.isArray(data)) continue
    for (const entry of data) {
      if (!entry || !entry.ts || !Array.isArray(entry.transactions)) continue
      const dayTs = getStartOfDay(normalizeTimestampMs(entry.ts))
      if (!dayTs || dayTs < startDay || dayTs > endDay) continue
      let revenueBTC = 0
      for (const tx of entry.transactions) {
        if (!tx) continue
        if (typeof tx.changed_balance === 'number') {
          revenueBTC += tx.changed_balance
        } else if (typeof tx.satoshis_net_earned === 'number') {
          revenueBTC += tx.satoshis_net_earned / BTC_SATS
        }
      }
      daily[dayTs] = (daily[dayTs] || 0) + revenueBTC
    }
  }
  return daily
}

function processDailyAvgPrices (results, start, end) {
  const startDay = getStartOfDay(start)
  const endDay = getStartOfDay(end)
  const sums = {}
  const counts = {}
  for (const res of results) {
    if (!res || res.error) continue
    const data = Array.isArray(res) ? res : (res.data || res.result || [])
    if (!Array.isArray(data)) continue
    for (const entry of data) {
      if (!entry) continue
      const dayTs = getStartOfDay(normalizeTimestampMs(entry.ts || entry.timestamp || entry.time))
      const price = entry.priceUSD ?? entry.price
      if (!dayTs || dayTs < startDay || dayTs > endDay || typeof price !== 'number') continue
      sums[dayTs] = (sums[dayTs] || 0) + price
      counts[dayTs] = (counts[dayTs] || 0) + 1
    }
  }
  const daily = {}
  for (const [dayTs, sum] of Object.entries(sums)) {
    daily[dayTs] = sum / counts[dayTs]
  }
  return daily
}

function sumCostsByMonth (costs, startMonthTs, endMonthTs) {
  const byMonth = {}
  if (!Array.isArray(costs)) return byMonth
  for (const entry of costs) {
    if (!entry || !entry.site || !entry.year || !entry.month) continue
    const monthTs = Date.UTC(Number(entry.year), Number(entry.month) - 1, 1)
    if (monthTs < startMonthTs || monthTs > endMonthTs) continue
    const totalCost = (Number(entry.energyCost) || 0) +
      (Number(entry.operationalCost) || 0) +
      (Number(entry.energyCostsUSD) || 0)
    if (totalCost > 0) {
      byMonth[monthTs] = (byMonth[monthTs] || 0) + totalCost
    }
  }
  return byMonth
}

async function getProductionCosts (ctx, start, end) {
  if (!ctx.globalDataLib) return []
  const costs = await ctx.globalDataLib.getGlobalData({
    type: GLOBAL_DATA_TYPES.PRODUCTION_COSTS
  })
  if (!Array.isArray(costs)) return []

  const startDate = new Date(start)
  const endDate = new Date(end)
  return costs.filter(entry => {
    if (!entry || !entry.year || !entry.month) return false
    const entryDate = new Date(entry.year, entry.month - 1, 1)
    return entryDate >= startDate && entryDate <= endDate
  })
}

function processCostsData (costs) {
  const byMonth = {}
  if (!Array.isArray(costs)) return byMonth
  for (const entry of costs) {
    if (!entry || !entry.year || !entry.month) continue
    const key = `${entry.year}-${String(entry.month).padStart(2, '0')}`
    const daysInMonth = new Date(entry.year, entry.month, 0).getDate()
    // A month saved by the Cost Input page carries no energy cost — it is derived from
    // consumption x LCOE by the caller. null marks "derive it", 0 marks "it is zero".
    const rawEnergyCost = entry.energyCost ?? entry.energyCostsUSD ?? null
    byMonth[key] = {
      energyCostPerDay: rawEnergyCost === null ? null : rawEnergyCost / daysInMonth,
      operationalCostPerDay: (entry.operationalCost || entry.operationalCostsUSD || 0) / daysInMonth
    }
  }
  return byMonth
}

// Cost Input pins the LCOE it used at save time, so no forecast-settings lookup is needed here.
async function getCostParameters (ctx) {
  if (!ctx.globalDataLib) return {}
  const params = await ctx.globalDataLib.getGlobalData({
    type: GLOBAL_DATA_TYPES.COST_PARAMETERS
  })
  return (params && typeof params === 'object') ? params : {}
}

// Cost parameters are stored as site defaults plus an `overrides` map keyed 'YYYY-MM'. A month with
// no override resolves to the base doc, so past figures never move.
function resolveCostParametersForMonth (costParameters, monthKey) {
  const override = monthKey ? costParameters?.overrides?.[monthKey] : null
  if (!override) return costParameters || {}
  return { ...costParameters, ...override, lcoe: { ...costParameters?.lcoe, ...override.lcoe } }
}

function resolveLcoeUsdPerMwh (costParameters, monthKey) {
  const lcoe = resolveCostParametersForMonth(costParameters, monthKey).lcoe
  const value = Number(lcoe?.effectiveUsdPerMwh)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

// energyCostPerDay is null only when a saved month carries no energy cost — derive those from the
// day's consumption. A month with no row at all stays 0, exactly as before.
function resolveEnergyCostsUSD (costs, consumptionMWh, lcoeUsdPerMwh) {
  if (costs.energyCostPerDay === null) return consumptionMWh * lcoeUsdPerMwh
  return costs.energyCostPerDay || 0
}

module.exports = {
  getEnergyBalance,
  getEbitda,
  getCostSummary,
  getSubsidyFees,
  getRevenue,
  getRevenueHourly,
  processHourlyRevenues,
  calculateHourlyRevenueSummary,
  getRevenueSummary,
  getHashRevenue,
  getPowerCost,
  getStartOfMonthUtc,
  processDailyRevenueBtc,
  processDailyAvgPrices,
  sumCostsByMonth,
  getProductionCosts,
  getCostParameters,
  resolveCostParametersForMonth,
  resolveLcoeUsdPerMwh,
  resolveEnergyCostsUSD,
  processPriceData,
  processEnergyData,
  extractNominalPower,
  processCostsData,
  calculateSummary,
  processEbitdaPrices,
  calculateEbitdaSummary,
  calculateCostSummary,
  calculateSubsidyFeesSummary,
  calculateRevenueSummary,
  calculateDetailedRevenueSummary,
  processNetworkHashrateData,
  calculateHashRevenueSummary,
  // Re-export from finance.utils
  validateStartEnd,
  normalizeTimestampMs,
  processTransactions,
  extractCurrentPrice,
  processBlockData
}
