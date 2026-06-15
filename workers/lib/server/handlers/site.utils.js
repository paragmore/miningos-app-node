'use strict'

const { extractKeyEntry, mhsToThs } = require('../../metrics.utils')
const { WORKER_TAGS } = require('../../constants')

function hsToMhs (hs) {
  return hs / 1000000
}

// tailLogMulti key index 0 = miner
function aggregateMinerStats (tailLogResults) {
  const stats = {
    hashrate: 0,
    nominalHashrate: 0,
    online: 0,
    error: 0,
    offline: 0,
    total: 0
  }

  for (const orkResult of tailLogResults) {
    const entry = extractKeyEntry(orkResult, 0)
    if (!entry) continue

    stats.hashrate += entry.hashrate_mhs_1m_sum_aggr || 0
    stats.nominalHashrate += entry.nominal_hashrate_mhs_sum_aggr || 0
    stats.online += entry.online_or_minor_error_miners_amount_aggr || 0
    stats.error += entry.not_mining_miners_amount_aggr || 0
    stats.offline += entry.offline_or_sleeping_miners_amount_aggr || 0
    stats.total += entry.hashrate_mhs_1m_cnt_aggr || 0
  }

  return stats
}

// Sums alerts over miner/powermeter/container entries (UI getTotalAlerts parity)
function aggregateAlertStats (tailLogResults) {
  const alerts = { critical: 0, high: 0, medium: 0 }

  for (const orkResult of tailLogResults) {
    for (let keyIndex = 0; keyIndex <= 2; keyIndex++) {
      const entry = extractKeyEntry(orkResult, keyIndex)
      const entryAlerts = entry && entry.alerts_aggr
      if (!entryAlerts || typeof entryAlerts !== 'object') continue
      alerts.critical += entryAlerts.critical || 0
      alerts.high += entryAlerts.high || 0
      alerts.medium += entryAlerts.medium || 0
    }
  }

  return alerts
}

// tailLogMulti key index 2 = container
function aggregateContainerCapacity (tailLogResults) {
  let capacity = 0

  for (const orkResult of tailLogResults) {
    const entry = extractKeyEntry(orkResult, 2)
    if (!entry) continue
    capacity += entry.container_nominal_miner_capacity_sum_aggr || 0
  }

  return capacity
}

// Each ork entry is { ts, stats: [...] }, one object per pool, hashrate in H/s
function aggregatePoolStats (poolDataResults) {
  const stats = {
    totalHashrateHs: 0,
    activeWorkers: 0,
    totalWorkers: 0
  }

  for (const orkResult of poolDataResults) {
    if (!Array.isArray(orkResult)) continue
    for (const entry of orkResult) {
      if (!entry || !entry.stats) continue
      const pools = Array.isArray(entry.stats) ? entry.stats : [entry.stats]
      for (const pool of pools) {
        if (!pool) continue
        stats.totalHashrateHs += pool.hashrate || 0
        stats.activeWorkers += pool.active_workers_count || 0
        stats.totalWorkers += pool.worker_count || 0
      }
    }
  }

  return stats
}

function extractGlobalConfig (globalConfigResults) {
  const config = {
    nominalHashrate: 0,
    nominalPowerAvailability_MW: 0
  }

  for (const orkResult of globalConfigResults) {
    if (!orkResult || typeof orkResult !== 'object') continue
    if (orkResult.nominalHashrate) { config.nominalHashrate = orkResult.nominalHashrate }
    if (orkResult.nominalPowerAvailability_MW) {
      config.nominalPowerAvailability_MW =
        orkResult.nominalPowerAvailability_MW
    }
  }

  return config
}

function computeUtilization (value, nominal) {
  if (!nominal || nominal === 0) return 0
  return Math.round((value / nominal) * 1000) / 10
}

function getFirstOrkThings (listThingsResults) {
  if (!Array.isArray(listThingsResults)) return []
  const first = listThingsResults[0]
  return Array.isArray(first) ? first : []
}

function isTransformerPowermeter (type, pos) {
  return typeof type === 'string' &&
    type.startsWith('powermeter-') &&
    /^tr\d+$/.test(pos || '')
}

// Sums power over transformer power meters (UI useTotalTransformerPMConsumption parity)
function sumTransformerPowerW (listThingsResults) {
  let totalW = 0

  for (const device of getFirstOrkThings(listThingsResults)) {
    if (!device) continue
    const pos = device.info && device.info.pos
    if (!isTransformerPowermeter(device.type, pos)) continue
    const powerW = device.last?.snap?.stats?.power_w
    if (typeof powerW !== 'number' || !powerW) continue
    totalW += powerW
  }

  return totalW
}

// First t-powermeter thing, falling back to t-container
function extractSiteMeterThing (listThingsResults) {
  const things = getFirstOrkThings(listThingsResults)
  const byTag = (tag) => things.filter(
    (thing) => Array.isArray(thing?.tags) && thing.tags.includes(tag)
  )

  const powerMeters = byTag(WORKER_TAGS.POWERMETER)
  const candidates = powerMeters.length > 0 ? powerMeters : byTag(WORKER_TAGS.CONTAINER)
  return candidates[0] || null
}

// Mirrors UI getAlertsString; empty when no alerts
function formatDeviceAlerts (alerts) {
  if (!Array.isArray(alerts) || alerts.length === 0) return ''
  return alerts.map((alert) =>
    `(${alert.severity}) ${new Date(alert.createdAt).toISOString()} : ${alert.name} Description: ${alert.description} ${alert.message ? alert.message : ''}`
  ).join(',\n\n')
}

function composeSiteStatus (
  tailLogResults,
  poolDataResults,
  globalConfigResults,
  consumption
) {
  const minerStats = aggregateMinerStats(tailLogResults)
  const alertStats = aggregateAlertStats(tailLogResults)
  const containerCapacity = aggregateContainerCapacity(tailLogResults)
  const poolStats = aggregatePoolStats(poolDataResults)
  const globalConfig = extractGlobalConfig(globalConfigResults)

  const nominalPowerW = globalConfig.nominalPowerAvailability_MW * 1000000
  const hashrateNominal =
    minerStats.nominalHashrate || globalConfig.nominalHashrate || 0

  const hashrateValue = minerStats.hashrate
  const consumptionW = consumption.powerW
  // UI getEfficiencyStat: W / TH/s, unrounded, 0 if either input is missing
  const efficiencyWPerTh = (consumptionW && hashrateValue)
    ? consumptionW / mhsToThs(hashrateValue)
    : 0

  const alertTotal =
    alertStats.critical +
    alertStats.high +
    alertStats.medium

  return {
    hashrate: {
      value: hashrateValue,
      nominal: hashrateNominal,
      utilization: computeUtilization(hashrateValue, hashrateNominal),
      unit: 'MH/s'
    },
    power: {
      value: consumptionW,
      nominal: nominalPowerW,
      utilization: computeUtilization(consumptionW, nominalPowerW),
      unit: 'W',
      alert: consumption.alert,
      error: Boolean(consumption.alert)
    },
    efficiency: {
      value: efficiencyWPerTh,
      unit: 'W/TH/s'
    },
    miners: {
      online: minerStats.online,
      offline: minerStats.offline,
      error: minerStats.error,
      total: minerStats.total,
      containerCapacity
    },
    alerts: {
      critical: alertStats.critical,
      high: alertStats.high,
      medium: alertStats.medium,
      total: alertTotal
    },
    pools: {
      totalHashrate: { value: hsToMhs(poolStats.totalHashrateHs), unit: 'MH/s' },
      activeWorkers: poolStats.activeWorkers,
      totalWorkers: poolStats.totalWorkers
    },
    ts: Date.now()
  }
}

module.exports = {
  hsToMhs,
  aggregateMinerStats,
  aggregateAlertStats,
  aggregateContainerCapacity,
  aggregatePoolStats,
  extractGlobalConfig,
  computeUtilization,
  getFirstOrkThings,
  isTransformerPowermeter,
  sumTransformerPowerW,
  extractSiteMeterThing,
  formatDeviceAlerts,
  composeSiteStatus
}
