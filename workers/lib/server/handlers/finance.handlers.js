'use strict'

const {
  WORKER_TYPES,
  AGGR_FIELDS,
  PERIOD_TYPES,
  MINERPOOL_EXT_DATA_KEYS,
  ELECTRICITY_EXT_DATA_KEYS,
  RPC_METHODS,
  GLOBAL_DATA_TYPES,
  BTC_SATS
} = require('../../constants')
const { localDayStart, safeDiv, runParallel } = require('../../utils')
const { parseEntryTs, localMonthsInRange, localMonthKey, localMonthStartTs } = require('../../metrics.utils')
const { aggregateByPeriod } = require('../../period.utils')
const { createMonthlyHashesCache } = require('../lib/monthlyHashesCache')
const { getConsumption, getHashrate } = require('./metrics.handlers')
const {
  validateStartEnd,
  resolveStartEnd,
  normalizeTimestampMs,
  processTransactions,
  extractCurrentPrice,
  processBlockData,
  historyLimit,
  priceDailyRevenue,
  pricingStatus
} = require('./finance.utils')
const { getCombinedPoolRebates } = require('./rebates.utils')
const { isCentralDCSEnabled, fetchDcsThing } = require('../../dcs.utils')
const lPhases = require('../../phases.utils')

// First instant of the local calendar month (in `timezone`) containing `ts`.
function localMonthStart (ts, timezone) {
  const [year, month] = localMonthKey(ts, timezone).split('-').map(Number)
  return localMonthStartTs(year, month, timezone)
}

// Daily site power and hashrate come from the metrics handlers: DCS-aware and averaged per
// bucket, unlike the range-aggr daily docs, which are raw sample sums and only exist for
// powermeter racks.
//
// The store's own '1d' bucket is UTC-aligned (interval '1d' maps to the 3h-sampled stat log,
// grouped '1D' - see getIntervalConfig), and a 3h source bucket can't be re-cut at a zone
// offset that isn't a multiple of 3 (e.g. Campo_Grande's -04:00: a bucket spanning 03:00-06:00
// UTC straddles that midnight and can't be split back into its two sides after the store has
// already averaged them together). So this always asks for '1h' (backed by 30m samples, which
// re-cut cleanly at any whole-hour offset) and rolls the hours up into `timezone`'s own calendar
// days itself - month by month, so a completed month's rollup can be cached and reused the same
// way getMonthlyHashrate caches its months.
//
// Cached on `ctx` rather than the module: routes build `ctx` once per process and reuse it for
// every request (see routes/*.js), so this keeps the same per-process lifetime getMonthlyHashrate's
// module-level cache has, while giving each test's freshly-built mock ctx its own cache instead of
// leaking rollups across unrelated tests that happen to share a date range.
function getDailySeriesCache (ctx) {
  if (!ctx._dailySeriesCache) ctx._dailySeriesCache = createMonthlyHashesCache()
  return ctx._dailySeriesCache
}

function dailySeriesCacheKey (monthKey, timezone, field) {
  return `${monthKey}|${timezone}|${field}`
}

function rollupLocalDaysMean (log, timezone, field) {
  const byDay = new Map()
  for (const entry of log) {
    if (!entry || typeof entry.ts !== 'number') continue
    const dayTs = localDayStart(entry.ts, timezone)
    const value = Number(entry[field])
    if (!Number.isFinite(value)) continue
    const values = byDay.get(dayTs) ?? []
    values.push(value)
    byDay.set(dayTs, values)
  }

  const days = {}
  for (const [dayTs, values] of byDay) {
    days[dayTs] = values.reduce((sum, v) => sum + v, 0) / values.length
  }
  return days
}

async function getDailySeries (ctx, start, end, handler, field, timezone, refresh = false, cacheTag = '') {
  const cache = getDailySeriesCache(ctx)
  const now = Date.now()
  const months = localMonthsInRange(start, end, timezone)
  // A month that has ended can be answered from cache, but only a month the request
  // covers end to end may be stored: a partial edge month is a slice, and caching it
  // as the whole would drop the days outside that slice from every later request.
  const ended = (month) => month.end < now
  const cacheable = (month) => ended(month) && month.start >= start && month.end <= end

  const byDay = {}
  const missing = []

  for (const month of months) {
    // refresh skips the read so a backfilled month is recomputed, but the fresh
    // rollup is still stored below and serves every later request.
    const cached = ended(month) && !refresh
      ? cache.get(dailySeriesCacheKey(month.key, timezone, field + cacheTag), now)
      : undefined
    if (cached) Object.assign(byDay, cached)
    else missing.push(month)
  }

  if (missing.length) {
    // One query over the span the misses cover, clamped to what was actually asked for -
    // the first and last month of a range are usually partial.
    const span = {
      start: Math.max(start, missing[0].start),
      end: Math.min(end, missing[missing.length - 1].end)
    }
    // A window ending exactly on a month boundary leaves a zero-width edge month; the
    // handlers reject start >= end, and there is nothing in it to fetch anyway.
    const { log } = span.end > span.start
      ? await handler(ctx, { query: { start: span.start, end: span.end, interval: '1h' } })
      : { log: [] }

    const byMonthLog = new Map()
    for (const entry of log) {
      if (!entry || typeof entry.ts !== 'number') continue
      const monthKey = localMonthKey(entry.ts, timezone)
      const monthLog = byMonthLog.get(monthKey) ?? []
      monthLog.push(entry)
      byMonthLog.set(monthKey, monthLog)
    }

    for (const month of missing) {
      const monthDays = rollupLocalDaysMean(byMonthLog.get(month.key) ?? [], timezone, field)
      Object.assign(byDay, monthDays)
      if (cacheable(month)) {
        cache.set(dailySeriesCacheKey(month.key, timezone, field + cacheTag), monthDays, now)
      }
    }
  }

  // A cached month is whole, so clamp to the local days [start, end] touches.
  const firstDay = localDayStart(start, timezone)
  for (const dayTs of Object.keys(byDay)) {
    if (Number(dayTs) < firstDay || Number(dayTs) > end) delete byDay[dayTs]
  }

  return byDay
}

// ==================== Energy Balance ====================

async function getEnergyBalance (ctx, req) {
  const { start, end, timezone } = resolveStartEnd(ctx, req)
  const period = req.query.period || PERIOD_TYPES.DAILY

  const [
    dailyConsumption,
    transactionResults,
    priceResults,
    currentPriceResults,
    productionCosts,
    activeEnergyInResults,
    globalConfigResults,
    costParameters,
    poolRebates
  ] = await runParallel([
    (cb) => getDailySeries(ctx, start, end, getConsumption, 'powerW', timezone)
      .then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MINERPOOL,
      query: { key: MINERPOOL_EXT_DATA_KEYS.TRANSACTIONS, start, end }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'HISTORICAL_PRICES', start, end, limit: historyLimit(start, end) }
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

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GLOBAL_CONFIG, {})
      .then(r => cb(null, r)).catch(cb),

    (cb) => getCostParameters(ctx)
      .then(r => cb(null, r)).catch(cb),

    (cb) => getPoolRebates(ctx, start, end)
      .then(r => cb(null, r)).catch(cb)
  ])

  const { txEntries } = processTransactions(transactionResults, { start, end }, timezone)
  const dailyPrices = processPriceData(priceResults, timezone)
  const currentBtcPrice = extractCurrentPrice(currentPriceResults)
  const { daily: dailyTransactions, missingPriceBuckets } = await priceDailyRevenue(ctx, {
    txEntries,
    rebates: poolRebates,
    dailyPrices,
    currentBtcPrice,
    timezone
  })
  const costsByMonth = processCostsData(productionCosts)
  const dailyActiveEnergyIn = processEnergyData(activeEnergyInResults, AGGR_FIELDS.ACTIVE_ENERGY_IN, timezone)
  const dailyUteEnergy = processEnergyData(activeEnergyInResults, AGGR_FIELDS.UTE_ENERGY, timezone)
  const nominalPowerMW = extractNominalPower(globalConfigResults)

  const allDays = new Set([
    ...Object.keys(dailyConsumption),
    ...Object.keys(dailyTransactions)
  ])

  const log = []
  for (const dayTs of [...allDays].sort()) {
    const ts = Number(dayTs)
    const transactions = dailyTransactions[dayTs] || {}
    const btcPrice = transactions.btcPrice || dailyPrices[dayTs] || currentBtcPrice || 0

    const powerW = dailyConsumption[dayTs] || 0
    const powerMWh = (powerW * 24) / 1000000
    const sitePowerMW = powerW / 1000000
    const revenueBTC = transactions.revenueBTC || 0
    const revenueUSD = transactions.revenueUSD || 0

    const monthKey = localMonthKey(ts, timezone)
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
      payoutBTC: transactions.payoutBTC || 0,
      rebateBTC: transactions.rebateBTC || 0,
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
      powerUtilization,
      unpricedPayouts: transactions.unpricedPayouts || 0
    })
  }

  const aggregated = aggregateByPeriod(log, period, [], {
    meanKeys: [
      'sitePowerMW', 'powerW', 'btcPrice', 'energyRevenuePerMWh', 'allInCostPerMWh',
      'curtailmentRate', 'operationalIssuesRate', 'powerUtilization'
    ],
    timezone
  })

  for (const entry of aggregated) {
    entry.energyRevenueBTC_MW = entry.sitePowerMW > 0 ? entry.revenueBTC / entry.sitePowerMW : 0
    entry.energyRevenueUSD_MW = entry.sitePowerMW > 0 ? entry.revenueUSD / entry.sitePowerMW : 0
  }
  aggregated.sort((a, b) => Number(a.ts) - Number(b.ts))

  const summary = calculateSummary(aggregated)

  return { log: aggregated, summary: { ...summary, ...pricingStatus(missingPriceBuckets) } }
}

function processPriceData (results, timezone) {
  const daily = {}
  for (const res of results) {
    if (res.error || !res) continue
    const data = Array.isArray(res) ? res : (res.data || res.result || [])
    if (!Array.isArray(data)) continue
    for (const entry of data) {
      if (!entry) continue
      const rawTs = entry.ts || entry.timestamp || entry.time
      const rawMs = normalizeTimestampMs(rawTs)
      const price = entry.priceUSD || entry.price
      if (rawMs && price) {
        daily[localDayStart(rawMs, timezone)] = price
      }
    }
  }
  return daily
}

// Both callers request stats-history with groupRange, so ts arrives as a "<start>-<end>"
// range string rather than a number; parseEntryTs reads its start, and an entry it can't
// parse is skipped.
function processEnergyData (results, aggrField, timezone) {
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
          const itemMs = parseEntryTs(item.ts || item.timestamp)
          if (!itemMs) continue
          const ts = localDayStart(itemMs, timezone)
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

async function getPoolRebates (ctx, start, end) {
  if (!ctx.globalDataLib) return []
  return await getCombinedPoolRebates(ctx, { start, end })
}

function processForecastHistory (results, timezone) {
  const daily = {}
  for (const res of results) {
    if (!res || res.error) continue
    for (const payload of Array.isArray(res) ? res : [res]) {
      for (const h of payload?.hourlyForecast || []) {
        if (!Number.isFinite(h?.energySalesRevenue)) continue
        const ts = localDayStart(Number(h.start), timezone)
        const d = daily[ts] ??= { energySalesGrossUSD: 0, energySalesTaxesAndFeesUSD: 0, soldMWh: 0, availableMWh: 0, allMineNetUSD: 0, allSellNetUSD: 0, optimalNetUSD: 0 }
        const mwh = safeDiv(h.energySalesRevenue, h.energySalesRevenuePerMwh) || 0
        const sellNet = h.energySalesRevenue || 0
        const mineNet = h.miningRevenue || 0
        if (h.isEnergySelected === true && h.decision !== 'mine') {
          d.energySalesGrossUSD += h.energySellPrice || 0
          d.energySalesTaxesAndFeesUSD += h.energySalesTaxesAndFees || 0
          d.soldMWh += mwh
        }
        d.availableMWh += mwh
        d.allMineNetUSD += mineNet
        d.allSellNetUSD += sellNet
        d.optimalNetUSD += Math.max(mineNet, sellNet)
      }
    }
  }
  return daily
}

function extractForecastSettings (results) {
  for (const res of results) {
    if (!res || res.error) continue
    for (const entry of Array.isArray(res) ? res : [res]) {
      if (entry?.miningRevenueTaxFees) return entry
    }
  }
  return {}
}

// A phase divides by its own nominal, not the site's; a phase that has no
// entry in the ork global config's phaseNominals map fails loudly instead of
// silently reporting uptime against the whole site.
function resolvePhaseNominalPowerMW (results, phase) {
  const powerMw = lPhases.getPhaseNominals(results, phase.id)?.powerMw
  if (!Number.isFinite(powerMw) || powerMw <= 0) throw lPhases.phaseError('ERR_PHASE_NOMINAL_MISSING')
  return powerMw
}

function extractNominalPower (results) {
  for (const res of results) {
    if (!res || res.error) continue
    const data = Array.isArray(res) ? res : [res]
    for (const entry of data) {
      if (!entry) continue
      const mw = entry.nominalPowerAvailability_MW || entry.nominalAvailablePowerMWh
      if (mw) return mw
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
  const { start, end, timezone } = resolveStartEnd(ctx, req)
  const period = req.query.period || PERIOD_TYPES.MONTHLY

  const [transactionResults, dailyPower, dailyHashrate, priceResults, currentPriceResults, productionCosts, costParameters, poolRebates] = await runParallel([
    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MINERPOOL,
      query: { key: MINERPOOL_EXT_DATA_KEYS.TRANSACTIONS, start, end }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => getDailySeries(ctx, start, end, getConsumption, 'powerW', timezone)
      .then(r => cb(null, r)).catch(cb),

    (cb) => getDailySeries(ctx, start, end, getHashrate, 'hashrateMhs', timezone)
      .then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'HISTORICAL_PRICES', start, end, limit: historyLimit(start, end) }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'current_price' }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => getProductionCosts(ctx, start, end)
      .then(r => cb(null, r)).catch(cb),

    (cb) => getCostParameters(ctx)
      .then(r => cb(null, r)).catch(cb),

    (cb) => getPoolRebates(ctx, start, end)
      .then(r => cb(null, r)).catch(cb)
  ])

  const { txEntries } = processTransactions(transactionResults, { start, end }, timezone)
  const dailyPrices = processEbitdaPrices(priceResults, timezone)
  const currentBtcPrice = extractCurrentPrice(currentPriceResults)
  const { daily: dailyTransactions, missingPriceBuckets } = await priceDailyRevenue(ctx, {
    txEntries,
    rebates: poolRebates,
    dailyPrices,
    currentBtcPrice,
    timezone
  })
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
    const btcPrice = transactions.btcPrice || dailyPrices[dayTs] || currentBtcPrice || 0

    const revenueBTC = transactions.revenueBTC || 0
    const revenueUSD = transactions.revenueUSD || 0
    const powerW = dailyPower[dayTs] || 0
    const hashrateMhs = dailyHashrate[dayTs] || 0
    const powerMWh = (powerW * 24) / 1000000

    const monthKey = localMonthKey(ts, timezone)
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
      payoutBTC: transactions.payoutBTC || 0,
      rebateBTC: transactions.rebateBTC || 0,
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
      btcProductionCost,
      unpricedPayouts: transactions.unpricedPayouts || 0
    })
  }

  const aggregated = aggregateByPeriod(log, period, [], {
    meanKeys: ['btcPrice', 'powerW', 'hashrateMhs'],
    timezone
  })
  for (const entry of aggregated) entry.btcProductionCost = safeDiv(entry.totalCostsUSD, entry.revenueBTC)
  const summary = calculateEbitdaSummary(aggregated, currentBtcPrice)

  return { log: aggregated, summary: { ...summary, ...pricingStatus(missingPriceBuckets) } }
}

function processEbitdaPrices (results, timezone) {
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
          const itemMs = item.ts || item.timestamp || item.time
          const price = item.priceUSD || item.price
          if (itemMs && price) {
            daily[localDayStart(itemMs, timezone)] = price
          }
        }
      } else if (typeof items === 'object') {
        for (const [key, val] of Object.entries(items)) {
          const keyMs = Number(key)
          if (keyMs) {
            daily[localDayStart(keyMs, timezone)] = typeof val === 'object' ? (val.USD || val.priceUSD || val.price || 0) : Number(val) || 0
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
  const { start, end, timezone } = resolveStartEnd(ctx, req)
  const period = req.query.period || PERIOD_TYPES.MONTHLY

  const [productionCosts, priceResults, dailyConsumption, costParameters] = await runParallel([
    (cb) => getProductionCosts(ctx, start, end)
      .then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'HISTORICAL_PRICES', start, end, limit: historyLimit(start, end) }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => getDailySeries(ctx, start, end, getConsumption, 'powerW', timezone)
      .then(r => cb(null, r)).catch(cb),

    (cb) => getCostParameters(ctx)
      .then(r => cb(null, r)).catch(cb)
  ])

  const costsByMonth = processCostsData(productionCosts)
  const dailyPrices = processEbitdaPrices(priceResults, timezone)

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

    const monthKey = localMonthKey(ts, timezone)
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
    meanKeys: ['btcPrice', 'allInCostPerMWh', 'energyCostPerMWh'],
    timezone
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
  const { start, end, timezone } = resolveStartEnd(ctx, req)
  const period = req.query.period || PERIOD_TYPES.DAILY

  const blockResults = await ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
    type: WORKER_TYPES.MEMPOOL,
    query: { key: 'HISTORICAL_BLOCKSIZES', start, end, limit: historyLimit(start, end) }
  })

  const dailyBlocks = processBlockData(blockResults, timezone)

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

  const aggregated = aggregateByPeriod(log, period, [], { timezone })
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
  const { start, end, timezone } = resolveStartEnd(ctx, req)
  const period = req.query.period || PERIOD_TYPES.DAILY
  const pool = req.query.pool || null

  const type = pool ? WORKER_TYPES.MINERPOOL + '-' + pool : WORKER_TYPES.MINERPOOL
  const query = { key: MINERPOOL_EXT_DATA_KEYS.TRANSACTIONS, start, end }

  const transactionResults = await ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
    type,
    query
  })

  // BTC-denominated only, so it needs no per-payout USD pricing.
  const { daily: dailyRevenue } = processTransactions(transactionResults, { trackFees: true, start, end }, timezone)

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

  const aggregated = aggregateByPeriod(log, period, [], { timezone })
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
  const { start, end } = resolveStartEnd(ctx, req)
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
  const phase = lPhases.resolvePhase(ctx, req)
  const { start, end, timezone } = resolveStartEnd(ctx, req)
  const period = req.query.period || PERIOD_TYPES.DAILY

  // A phase scopes earnings and hashrate to its own pool accounts. Consumption
  // still reads the site series through the getPhaseConsumption seam until the
  // manual store is wired in, so phase rows split revenue/hashes correctly and
  // their power-derived figures stay site-wide for now.
  const phaseUsernames = phase ? lPhases.getPhaseUsernames(phase) : null
  const phaseHashrate = phase
    ? (c, r) => getHashrate(c, { ...r, query: { ...r.query, phase: phase.id } })
    : getHashrate
  const phaseCacheTag = phase ? `|${phase.id}` : ''

  const [
    transactionResults,
    priceResults,
    currentPriceResults,
    dailyPower,
    dailyMiningPower,
    dailyHashrate,
    productionCosts,
    blockResults,
    globalConfigResults,
    costParameters,
    poolRebates,
    forecastResults,
    forecastSettingsResults
  ] = await runParallel([
    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MINERPOOL,
      query: { key: MINERPOOL_EXT_DATA_KEYS.TRANSACTIONS, start, end }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'HISTORICAL_PRICES', start, end, limit: historyLimit(start, end) }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'current_price' }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => getDailySeries(ctx, start, end, getConsumption, 'powerW', timezone)
      .then(r => cb(null, r)).catch(cb),

    (cb) => getDailySeries(ctx, start, end, getMiningConsumption, 'miningPowerW', timezone)
      .then(r => cb(null, r)).catch(cb),

    (cb) => getDailySeries(ctx, start, end, phaseHashrate, 'hashrateMhs', timezone, false, phaseCacheTag)
      .then(r => cb(null, r)).catch(cb),

    (cb) => getProductionCosts(ctx, start, end)
      .then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'HISTORICAL_BLOCKSIZES', start, end, limit: historyLimit(start, end) }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GLOBAL_CONFIG, {})
      .then(r => cb(null, r)).catch(cb),

    (cb) => getCostParameters(ctx)
      .then(r => cb(null, r)).catch(cb),

    (cb) => getPoolRebates(ctx, start, end)
      .then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.ELECTRICITY,
      query: { key: ELECTRICITY_EXT_DATA_KEYS.FORECAST_HISTORY },
      start,
      end,
      includeDays: false,
      forecastFields: { start: 1, decision: 1, energySellPrice: 1, energySalesRevenue: 1, energySalesRevenuePerMwh: 1, energySalesTaxesAndFees: 1, miningRevenue: 1, taxesAndFees: 1, isEnergySelected: 1 }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.ELECTRICITY,
      query: { key: ELECTRICITY_EXT_DATA_KEYS.FORECAST_SETTINGS }
    }).then(r => cb(null, r)).catch(cb)
  ])

  const { txEntries } = processTransactions(transactionResults, { trackFees: true, start, end, usernames: phaseUsernames }, timezone)
  const dailyPrices = processEbitdaPrices(priceResults, timezone)
  const currentBtcPrice = extractCurrentPrice(currentPriceResults)
  const { daily: dailyRevenue, missingPriceBuckets } = await priceDailyRevenue(ctx, {
    txEntries,
    rebates: phase ? [] : poolRebates,
    dailyPrices,
    currentBtcPrice,
    timezone,
    trackFees: true
  })
  const costsByMonth = processCostsData(productionCosts)
  if (phase && phase.consumption?.source === lPhases.CONSUMPTION_SOURCES.MANUAL) {
    // Site opex from Cost Input belongs to the site build-out; a manual-source
    // phase (the container) carries only its energy costs.
    for (const month of Object.values(costsByMonth)) month.operationalCostPerDay = 0
  }
  const dailyBlocks = processBlockData(blockResults, timezone)
  const nominalPowerMW = phase
    ? resolvePhaseNominalPowerMW(globalConfigResults, phase)
    : extractNominalPower(globalConfigResults)
  const dailyForecast = processForecastHistory(forecastResults, timezone)
  const taxFees = extractForecastSettings(forecastSettingsResults).miningRevenueTaxFees || {}

  const allDays = new Set([
    ...Object.keys(dailyRevenue),
    ...Object.keys(dailyForecast),
    ...Object.keys(dailyPower),
    ...Object.keys(dailyHashrate),
    ...Object.keys(dailyPrices)
  ])

  const log = []
  for (const dayTs of [...allDays].sort()) {
    const ts = Number(dayTs)
    // Forecast and price days are not clamped at their source, unlike transactions.
    if (ts < start || ts > end) continue

    const revenue = dailyRevenue[dayTs] || {}
    const btcPrice = revenue.btcPrice || dailyPrices[dayTs] || currentBtcPrice || 0
    const block = dailyBlocks[dayTs] || {}

    const revenueBTC = revenue.revenueBTC || 0
    const feesBTC = revenue.feesBTC || 0
    const revenueUSD = revenue.revenueUSD || 0
    const feesUSD = revenue.feesUSD || 0

    const powerW = dailyPower[dayTs] || 0
    const consumptionMWh = (powerW * 24) / 1000000
    // A day the hashrate series never reported is unknown, not zero. Zero-filling it here
    // drags the caller's period average down — a window with a telemetry gap reads as if the
    // site had been idle. `aggregateByPeriod` skips null for mean keys, and the monthly
    // hashrate rollup already leaves unreported months absent rather than zero-filled
    // (metrics.handlers.js), so null is the shape the rest of the stack expects.
    const hashrateMhs = dayTs in dailyHashrate ? dailyHashrate[dayTs] : null
    const hashratePhs = hashrateMhs === null ? null : hashrateMhs / 1e9

    const monthKey = localMonthKey(ts, timezone)
    const costs = costsByMonth[monthKey] || {}
    const lcoeUsdPerMwh = resolveLcoeUsdPerMwh(costParameters, monthKey)
    const energyCostsUSD = resolveEnergyCostsUSD(costs, consumptionMWh, lcoeUsdPerMwh)
    const operationalCostsUSD = costs.operationalCostPerDay || 0
    const totalCostsUSD = energyCostsUSD + operationalCostsUSD

    const nominalConsumptionMWh = nominalPowerMW * 24
    const fc = dailyForecast[dayTs] || {}
    const energySalesNetUSD = (fc.energySalesGrossUSD || 0) - (fc.energySalesTaxesAndFeesUSD || 0)
    const miningNetUSD = revenueUSD - revenueUSD * (taxFees.percent || 0) / 100 - (taxFees.fixed || 0) * consumptionMWh

    const actualPowerMW = powerW / 1000000
    const powerUtilization = nominalPowerMW > 0
      ? safeDiv(actualPowerMW, nominalPowerMW)
      : null

    log.push({
      ts,
      revenueBTC,
      payoutBTC: revenue.payoutBTC || 0,
      rebateBTC: revenue.rebateBTC || 0,
      feesBTC,
      revenueUSD,
      feesUSD,
      btcPrice,
      powerW,
      consumptionMWh,
      ...(dayTs in dailyMiningPower && { miningConsumptionMWh: (dailyMiningPower[dayTs] * 24) / 1000000 }),
      hashrateMhs,
      energyCostsUSD,
      operationalCostsUSD,
      totalCostsUSD,
      ebitdaSelling: revenueUSD - totalCostsUSD,
      ebitdaHodl: (revenueBTC * currentBtcPrice) - totalCostsUSD,
      btcProductionCost: safeDiv(totalCostsUSD, revenueBTC),
      energyRevenuePerMWh: safeDiv(revenueUSD, consumptionMWh),
      netEnergyRevenuePerMWh: safeDiv(miningNetUSD, consumptionMWh),
      allInCostPerMWh: safeDiv(totalCostsUSD, consumptionMWh),
      hashRevenueBTCPerPHsPerDay: safeDiv(revenueBTC, hashratePhs),
      hashRevenueUSDPerPHsPerDay: safeDiv(revenueUSD, hashratePhs),
      netHashRevenueUSDPerPHsPerDay: safeDiv(miningNetUSD, hashratePhs),
      blockReward: block.blockReward || 0,
      blockTotalFees: block.blockTotalFees || 0,
      blockSize: block.blockSize || 0,
      curtailmentMWh: 0,
      curtailmentRate: 0,
      operationalIssuesRate: 0,
      powerUtilization,
      availableEnergyMWh: 0,
      nominalConsumptionMWh,
      downtimeMWh: nominalPowerMW > 0 ? nominalConsumptionMWh - consumptionMWh : null,
      lcoeUsdPerMwh,
      energySalesGrossUSD: fc.energySalesGrossUSD || 0,
      energySalesTaxesAndFeesUSD: fc.energySalesTaxesAndFeesUSD || 0,
      energySalesNetUSD,
      soldMWh: fc.soldMWh || 0,
      availableMWh: fc.availableMWh || 0,
      allMineNetUSD: fc.allMineNetUSD || 0,
      allSellNetUSD: fc.allSellNetUSD || 0,
      optimalNetUSD: fc.optimalNetUSD || 0,
      miningNetUSD,
      netCashUSD: miningNetUSD + energySalesNetUSD - totalCostsUSD,
      unpricedPayouts: revenue.unpricedPayouts || 0
    })
  }

  const aggregated = aggregateByPeriod(log, period, [], {
    meanKeys: [
      'btcPrice', 'powerW', 'hashrateMhs', 'energyRevenuePerMWh', 'netEnergyRevenuePerMWh', 'allInCostPerMWh',
      'hashRevenueBTCPerPHsPerDay', 'hashRevenueUSDPerPHsPerDay', 'netHashRevenueUSDPerPHsPerDay',
      'curtailmentRate', 'operationalIssuesRate', 'powerUtilization', 'lcoeUsdPerMwh'
    ],
    timezone
  })
  for (const entry of aggregated) {
    entry.btcProductionCost = safeDiv(entry.totalCostsUSD, entry.revenueBTC)
    entry.miningConsumptionMWh ??= null
  }
  const summary = calculateDetailedRevenueSummary(aggregated, currentBtcPrice)

  return { log: aggregated, summary: { ...summary, ...pricingStatus(missingPriceBuckets) } }
}

function calculateDetailedRevenueSummary (log, currentBtcPrice) {
  if (!log.length) {
    return {
      totalRevenueBTC: 0,
      totalRevenueUSD: 0,
      totalFeesBTC: 0,
      totalFeesUSD: 0,
      totalAvailableEnergyMWh: 0,
      totalNominalConsumptionMWh: 0,
      totalDowntimeMWh: 0,
      totalPayoutBTC: 0,
      totalRebateBTC: 0,
      totalEnergySalesGrossUSD: 0,
      totalEnergySalesTaxesAndFeesUSD: 0,
      totalEnergySalesNetUSD: 0,
      totalSoldMWh: 0,
      totalAvailableMWh: 0,
      totalAllMineNetUSD: 0,
      totalAllSellNetUSD: 0,
      totalOptimalNetUSD: 0,
      totalMiningNetUSD: 0,
      totalNetCashUSD: 0,
      totalCostsUSD: 0,
      totalConsumptionMWh: 0,
      totalMiningConsumptionMWh: null,
      avgCostPerMWh: null,
      avgRevenuePerMWh: null,
      avgNetRevenuePerMWh: null,
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
    acc.availableEnergyMWh += entry.availableEnergyMWh || 0
    acc.nominalConsumptionMWh += entry.nominalConsumptionMWh || 0
    acc.downtimeMWh += entry.downtimeMWh || 0
    acc.payoutBTC += entry.payoutBTC || 0
    acc.rebateBTC += entry.rebateBTC || 0
    acc.energySalesGrossUSD += entry.energySalesGrossUSD || 0
    acc.energySalesTaxesAndFeesUSD += entry.energySalesTaxesAndFeesUSD || 0
    acc.energySalesNetUSD += entry.energySalesNetUSD || 0
    acc.soldMWh += entry.soldMWh || 0
    acc.availableMWh += entry.availableMWh || 0
    acc.allMineNetUSD += entry.allMineNetUSD || 0
    acc.allSellNetUSD += entry.allSellNetUSD || 0
    acc.optimalNetUSD += entry.optimalNetUSD || 0
    acc.miningNetUSD += entry.miningNetUSD || 0
    acc.netCashUSD += entry.netCashUSD || 0
    acc.consumptionMWh += entry.consumptionMWh || 0
    if (entry.miningConsumptionMWh != null) acc.miningConsumptionMWh = (acc.miningConsumptionMWh ?? 0) + entry.miningConsumptionMWh
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
    availableEnergyMWh: 0,
    nominalConsumptionMWh: 0,
    downtimeMWh: 0,
    payoutBTC: 0,
    rebateBTC: 0,
    energySalesGrossUSD: 0,
    energySalesTaxesAndFeesUSD: 0,
    energySalesNetUSD: 0,
    soldMWh: 0,
    availableMWh: 0,
    allMineNetUSD: 0,
    allSellNetUSD: 0,
    optimalNetUSD: 0,
    miningNetUSD: 0,
    netCashUSD: 0,
    consumptionMWh: 0,
    miningConsumptionMWh: null,
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
    totalAvailableEnergyMWh: totals.availableEnergyMWh,
    totalNominalConsumptionMWh: totals.nominalConsumptionMWh,
    totalDowntimeMWh: totals.downtimeMWh,
    totalPayoutBTC: totals.payoutBTC,
    totalRebateBTC: totals.rebateBTC,
    totalEnergySalesGrossUSD: totals.energySalesGrossUSD,
    totalEnergySalesTaxesAndFeesUSD: totals.energySalesTaxesAndFeesUSD,
    totalEnergySalesNetUSD: totals.energySalesNetUSD,
    totalSoldMWh: totals.soldMWh,
    totalAvailableMWh: totals.availableMWh,
    totalAllMineNetUSD: totals.allMineNetUSD,
    totalAllSellNetUSD: totals.allSellNetUSD,
    totalAllSellNetUSDPerMWh: safeDiv(totals.allSellNetUSD, totals.availableMWh),
    totalOptimalNetUSD: totals.optimalNetUSD,
    totalMiningNetUSD: totals.miningNetUSD,
    totalNetCashUSD: totals.netCashUSD,
    totalCostsUSD: totals.costsUSD,
    totalConsumptionMWh: totals.consumptionMWh,
    totalMiningConsumptionMWh: totals.miningConsumptionMWh,
    avgCostPerMWh: safeDiv(totals.costsUSD, totals.consumptionMWh),
    avgRevenuePerMWh: safeDiv(totals.revenueUSD, totals.consumptionMWh),
    avgNetRevenuePerMWh: safeDiv(totals.miningNetUSD, totals.consumptionMWh),
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
  const { start, end, timezone } = resolveStartEnd(ctx, req)
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

    (cb) => getDailySeries(ctx, start, end, getHashrate, 'hashrateMhs', timezone)
      .then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'HISTORICAL_PRICES', start, end, limit: historyLimit(start, end) }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'current_price' }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'HISTORICAL_HASHRATE', start, end, limit: historyLimit(start, end) }
    }).then(r => cb(null, r)).catch(cb)
  ])

  const { txEntries } = processTransactions(transactionResults, { trackFees: true, start, end }, timezone)
  const dailyPrices = processEbitdaPrices(priceResults, timezone)
  const currentBtcPrice = extractCurrentPrice(currentPriceResults)
  const { daily: dailyTransactions, missingPriceBuckets } = await priceDailyRevenue(ctx, {
    txEntries,
    dailyPrices,
    currentBtcPrice,
    timezone,
    trackFees: true
  })
  const dailyNetworkHashrate = processNetworkHashrateData(networkHashrateResults, timezone)

  const allDays = new Set([
    ...Object.keys(dailyTransactions),
    ...Object.keys(dailyHashrate)
  ])

  const log = []
  for (const dayTs of [...allDays].sort()) {
    const ts = Number(dayTs)
    const transactions = dailyTransactions[dayTs] || {}
    const btcPrice = transactions.btcPrice || dailyPrices[dayTs] || currentBtcPrice || 0

    const revenueBTC = transactions.revenueBTC || 0
    const feesBTC = transactions.feesBTC || 0
    const revenueUSD = transactions.revenueUSD || 0
    const feesUSD = transactions.feesUSD || 0
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
      networkHashrateMhs,
      unpricedPayouts: transactions.unpricedPayouts || 0
    })
  }

  const aggregated = aggregateByPeriod(log, period, [], {
    meanKeys: [
      'btcPrice', 'hashrateMhs', 'networkHashrateMhs',
      'hashRevenueBTCPerPHsPerDay', 'hashRevenueUSDPerPHsPerDay', 'hashCostBTCPerPHsPerDay', 'hashCostUSDPerPHsPerDay',
      'networkHashPriceBTCPerPHsPerDay', 'networkHashPriceUSDPerPHsPerDay'
    ],
    timezone
  })
  const summary = calculateHashRevenueSummary(aggregated)

  return { log: aggregated, summary: { ...summary, ...pricingStatus(missingPriceBuckets) } }
}

function processNetworkHashrateData (results, timezone) {
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
          const itemMs = normalizeTimestampMs(itemTs)
          if (!itemMs) continue
          const ts = localDayStart(itemMs, timezone)
          if (item.avgHashrateMHs) {
            daily[ts] = item.avgHashrateMHs
          }
        }
      } else if (typeof items === 'object') {
        for (const [key, val] of Object.entries(items)) {
          const keyMs = Number(key)
          if (!keyMs) continue
          const ts = localDayStart(keyMs, timezone)
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

async function getPowerCost (ctx, req) {
  const { start, end, timezone } = resolveStartEnd(ctx, req)
  const startMonthTs = localMonthStart(start, timezone)
  const endMonthTs = localMonthStart(end, timezone)

  const [
    dailyAvgPowerW,
    transactionResults,
    priceResults,
    productionCosts
  ] = await runParallel([
    (cb) => getDailySeries(ctx, start, end, getConsumption, 'powerW', timezone)
      .then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MINERPOOL,
      query: { key: MINERPOOL_EXT_DATA_KEYS.TRANSACTIONS, start, end }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
      type: WORKER_TYPES.MEMPOOL,
      query: { key: 'HISTORICAL_PRICES', start, end, limit: historyLimit(start, end) }
    }).then(r => cb(null, r)).catch(cb),

    (cb) => getProductionCosts(ctx, start, end)
      .then(r => cb(null, r)).catch(cb)
  ])

  const dailyRevenueBTC = processDailyRevenueBtc(transactionResults, start, end, timezone)
  const dailyAvgPrices = processDailyAvgPrices(priceResults, start, end, timezone)
  const costsByMonth = sumCostsByMonth(productionCosts, startMonthTs, endMonthTs, timezone)

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
    monthBucket(localMonthStart(Number(dayTs), timezone)).revenueUSD += revenueBTC * price
  }

  const dailyAvgWByMonth = {}
  for (const [dayTs, avgW] of Object.entries(dailyAvgPowerW)) {
    const monthTs = localMonthStart(Number(dayTs), timezone)
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

function processDailyRevenueBtc (results, start, end, timezone) {
  const startDay = localDayStart(start, timezone)
  const endDay = localDayStart(end, timezone)
  const daily = {}
  for (const res of results) {
    if (!res || res.error) continue
    const data = Array.isArray(res) ? res : (res.data || res.result || [])
    if (!Array.isArray(data)) continue
    for (const entry of data) {
      if (!entry || !entry.ts || !Array.isArray(entry.transactions)) continue
      const entryMs = normalizeTimestampMs(entry.ts)
      if (!entryMs) continue
      const dayTs = localDayStart(entryMs, timezone)
      if (dayTs < startDay || dayTs > endDay) continue
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

function processDailyAvgPrices (results, start, end, timezone) {
  const startDay = localDayStart(start, timezone)
  const endDay = localDayStart(end, timezone)
  const sums = {}
  const counts = {}
  for (const res of results) {
    if (!res || res.error) continue
    const data = Array.isArray(res) ? res : (res.data || res.result || [])
    if (!Array.isArray(data)) continue
    for (const entry of data) {
      if (!entry) continue
      const entryMs = normalizeTimestampMs(entry.ts || entry.timestamp || entry.time)
      const price = entry.priceUSD ?? entry.price
      if (!entryMs || typeof price !== 'number') continue
      const dayTs = localDayStart(entryMs, timezone)
      if (dayTs < startDay || dayTs > endDay) continue
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

function sumCostsByMonth (costs, startMonthTs, endMonthTs, timezone) {
  const byMonth = {}
  if (!Array.isArray(costs)) return byMonth
  for (const entry of costs) {
    if (!entry || !entry.site || !entry.year || !entry.month) continue
    const monthTs = localMonthStartTs(Number(entry.year), Number(entry.month), timezone)
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

  return costs.filter(entry => entry && entry.year && entry.month &&
    Date.UTC(entry.year, entry.month - 1, 1) <= end &&
    Date.UTC(entry.year, entry.month, 1) > start)
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

// by_meter_power_w keys are the DCS worker's snake-cased equipment ids (QDFL-1P -> qdfl-1_p).
const meterKey = (id) => String(id).toLowerCase().replace(/[^a-z0-9]/g, '')

// Mining power = the DCS "rack" power meters; hours without a rack reading are left unknown.
async function getMiningConsumption (ctx, req) {
  if (!isCentralDCSEnabled(ctx)) return { log: [] }

  const [{ log }, dcsThing] = await Promise.all([
    getConsumption(ctx, { ...req, query: { ...req.query, byMeter: true } }),
    fetchDcsThing(ctx, { type: 1, 'last.snap.stats.dcs_specific.equipment.power_meters': 1 })
  ])
  const powerMeters = dcsThing?.last?.snap?.stats?.dcs_specific?.equipment?.power_meters || []
  const rackMeters = new Set(powerMeters.filter(pm => pm.role === 'rack').map(pm => meterKey(pm.equipment)))

  return {
    log: log.map(({ ts, powerW }) => {
      const rack = Object.entries(powerW).filter(([meter]) => rackMeters.has(meterKey(meter)))
      return { ts, miningPowerW: rack.length ? rack.reduce((sum, [, w]) => sum + (Number(w) || 0), 0) : undefined }
    })
  }
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
  extractForecastSettings,
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
  getDailySeries,
  getDailySeriesCache,
  localMonthStart,
  // Re-export from finance.utils
  validateStartEnd,
  resolveStartEnd,
  normalizeTimestampMs,
  processTransactions,
  extractCurrentPrice,
  processBlockData
}
