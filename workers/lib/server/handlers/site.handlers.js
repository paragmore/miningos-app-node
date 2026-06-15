'use strict'

const {
  extractKeyEntry,
  mhsToPhs,
  mhsToThs,
  parseRackId,
  getGroupNumber,
  mergeGroupedField,
  buildGroupPowerFromDCS
} = require('../../metrics.utils')
const {
  LOG_KEYS,
  WORKER_TYPES,
  WORKER_TAGS,
  SITE_OVERVIEW_AGGR_FIELDS,
  SITE_STATUS_LIVE_AGGR_FIELDS,
  SITE_STATUS_LIVE_WINDOW_MS,
  DCS_POWER_METER_FIELDS,
  DCS_EFFICIENCY_FIELDS
} = require('../../constants')
const {
  isCentralDCSEnabled,
  getDCSTag,
  extractDcsThing,
  fetchDcsThing
} = require('../../dcs.utils')
const {
  sumTransformerPowerW,
  extractSiteMeterThing,
  formatDeviceAlerts,
  composeSiteStatus
} = require('./site.utils')

// DCS site main meter (role: site_main), same source as the energy layout view; reported in kW
async function getDCSSiteConsumption (ctx) {
  const dcsThing = await fetchDcsThing(ctx, {
    id: 1,
    code: 1,
    type: 1,
    tags: 1,
    ...DCS_POWER_METER_FIELDS
  })

  const powerMeters = dcsThing?.last?.snap?.stats?.dcs_specific?.equipment?.power_meters || []
  const siteMeter = powerMeters.find(pm => pm.role === 'site_main')
  const siteMeterKw = siteMeter?.power?.value || 0

  return { powerW: siteMeterKw * 1000, alert: '' }
}

// Resolves consumption by featureConfig, mirroring the header UI:
// central DCS > totalSystemConsumptionHeader (0) > totalTransformerConsumptionHeader > site meter
async function getSiteConsumption (ctx) {
  const featureConfig = ctx.conf.featureConfig || {}

  if (isCentralDCSEnabled(ctx)) {
    return getDCSSiteConsumption(ctx)
  }

  if (featureConfig.totalSystemConsumptionHeader) {
    return { powerW: 0, alert: '' }
  }

  if (featureConfig.totalTransformerConsumptionHeader) {
    const results = await ctx.dataProxy.requestDataMap('listThings', {
      query: {
        $and: [
          { tags: { $in: [WORKER_TAGS.POWERMETER] } },
          { 'info.pos': { $regex: 'tr' } }
        ]
      },
      status: 1,
      limit: 200,
      sort: { 'info.pos': 1 },
      fields: { 'last.snap.stats.power_w': 1, info: 1, type: 1 }
    })
    return { powerW: sumTransformerPowerW(results), alert: '' }
  }

  const results = await ctx.dataProxy.requestDataMap('listThings', {
    query: { 'info.pos': { $eq: 'site' } },
    status: 1,
    limit: 100,
    fields: { id: 1, 'last.snap.stats.power_w': 1, 'last.alerts': 1, tags: 1 }
  })
  const siteMeter = extractSiteMeterThing(results)
  return {
    powerW: siteMeter?.last?.snap?.stats?.power_w || 0,
    alert: formatDeviceAlerts(siteMeter?.last?.alerts)
  }
}

// GET /auth/site/status/live — composite snapshot (tailLog + consumption + pools + globalConfig),
// replacing 5 separate frontend calls
async function getSiteLiveStatus (ctx, req) {
  const tailLogPayload = {
    keys: [
      { key: LOG_KEYS.STAT_RTD, type: WORKER_TYPES.MINER, tag: WORKER_TAGS.MINER },
      { key: LOG_KEYS.STAT_RTD, type: WORKER_TYPES.POWERMETER, tag: WORKER_TAGS.POWERMETER },
      { key: LOG_KEYS.STAT_RTD, type: WORKER_TYPES.CONTAINER, tag: WORKER_TAGS.CONTAINER }
    ],
    limit: 1,
    start: Date.now() - SITE_STATUS_LIVE_WINDOW_MS,
    aggrFields: SITE_STATUS_LIVE_AGGR_FIELDS
  }

  const poolPayload = {
    type: 'minerpool',
    query: { key: 'stats' }
  }

  const globalConfigPayload = {
    fields: { nominalHashrate: 1, nominalPowerAvailability_MW: 1 }
  }

  const [tailLogResults, poolDataResults, globalConfigResults, consumption] =
    await Promise.all([
      ctx.dataProxy.requestDataMap('tailLogMulti', tailLogPayload),
      ctx.dataProxy.requestDataMap('getWrkExtData', poolPayload),
      ctx.dataProxy.requestDataMap('getGlobalConfig', globalConfigPayload),
      getSiteConsumption(ctx)
    ])

  return composeSiteStatus(
    tailLogResults,
    poolDataResults,
    globalConfigResults,
    consumption
  )
}

function aggregateOverviewMinerStats (tailLogResults) {
  const aggregated = {
    hashrateByGroup: {},
    hashrateByRack: {},
    powerByGroup: {},
    powerByRack: {},
    efficiencyByGroup: {},
    efficiencyByRack: {},
    offlineByGroup: {},
    errorByGroup: {},
    notMiningByGroup: {},
    sleepByGroup: {},
    lowByGroup: {},
    normalByGroup: {},
    highByGroup: {},
    activeCountByGroup: {}
  }

  for (const orkResult of tailLogResults) {
    const entry = extractKeyEntry(orkResult, 0)
    if (!entry) continue

    mergeGroupedField(aggregated.hashrateByGroup, entry.hashrate_mhs_5m_container_group_sum_aggr)
    mergeGroupedField(aggregated.hashrateByRack, entry.hashrate_mhs_5m_pdu_rack_group_avg_aggr)
    mergeGroupedField(aggregated.powerByGroup, entry.power_w_container_group_sum_aggr)
    mergeGroupedField(aggregated.powerByRack, entry.power_w_pdu_rack_group_sum_aggr)
    mergeGroupedField(aggregated.efficiencyByGroup, entry.efficiency_w_ths_container_group_avg_aggr, true)
    mergeGroupedField(aggregated.efficiencyByRack, entry.efficiency_w_ths_pdu_rack_group_avg_aggr, true)
    mergeGroupedField(aggregated.offlineByGroup, entry.offline_cnt)
    mergeGroupedField(aggregated.errorByGroup, entry.error_cnt)
    mergeGroupedField(aggregated.notMiningByGroup, entry.not_mining_cnt)
    mergeGroupedField(aggregated.sleepByGroup, entry.power_mode_sleep_cnt)
    mergeGroupedField(aggregated.lowByGroup, entry.power_mode_low_cnt)
    mergeGroupedField(aggregated.normalByGroup, entry.power_mode_normal_cnt)
    mergeGroupedField(aggregated.highByGroup, entry.power_mode_high_cnt)
    mergeGroupedField(aggregated.activeCountByGroup, entry.hashrate_mhs_5m_active_container_group_cnt)
  }

  return aggregated
}

function buildRacksForGroup (groupName, minerStats, racksPerGroup) {
  const racks = []
  const rackKeys = Object.keys(minerStats.hashrateByRack)
    .filter(key => key.startsWith(groupName + '_'))
    .sort((a, b) => {
      const rackA = parseRackId(a)
      const rackB = parseRackId(b)
      if (!rackA || !rackB) return 0
      return rackA.rack.localeCompare(rackB.rack, undefined, { numeric: true })
    })

  for (const rackKey of rackKeys) {
    const parsed = parseRackId(rackKey)
    if (!parsed) continue

    const hashrateMhs = minerStats.hashrateByRack[rackKey] || 0
    const powerW = minerStats.powerByRack[rackKey] || 0
    const powerKw = Math.round(powerW / 10) / 100 // W to kW with 2 decimals
    const hashrateThs = mhsToThs(hashrateMhs)
    const efficiency = hashrateThs > 0
      ? Math.round((powerW / hashrateThs) * 10) / 10
      : minerStats.efficiencyByRack[rackKey] || 0

    racks.push({
      id: parsed.rack,
      name: `Rack ${parsed.rack}`,
      efficiency: { value: efficiency, unit: 'W/TH/s' },
      consumption: { value: powerKw, unit: 'kW' },
      hashrate: { value: mhsToPhs(hashrateMhs), unit: 'PH/s' }
    })
  }

  return racks
}

function getMinersPerGroup (miningConfig) {
  const racksPerGroup = miningConfig?.racks_per_group || 4
  const minersPerRack = miningConfig?.miners_per_rack || 20
  return racksPerGroup * minersPerRack
}

function composeGroupsStats (minerStats, dcsThing, totalGroups) {
  const groups = []
  const config = dcsThing?.last?.snap?.config || {}
  const miningConfig = config.mining || {}
  const energyLayout = config.energy_layout || {}
  const powerMeters = dcsThing?.last?.snap?.stats?.dcs_specific?.equipment?.power_meters || []
  const racksPerGroup = miningConfig?.racks_per_group || 4
  const minersPerGroup = getMinersPerGroup(miningConfig)

  const dcsPowerByGroup = buildGroupPowerFromDCS(
    powerMeters,
    minerStats.hashrateByGroup,
    energyLayout,
    miningConfig
  )

  const groupNames = Object.keys(minerStats.hashrateByGroup)
    .filter(name => name.startsWith('group-'))
    .sort((a, b) => getGroupNumber(a) - getGroupNumber(b))

  const maxGroups = totalGroups || groupNames.length
  for (let i = 1; i <= maxGroups; i++) {
    const groupName = `group-${i}`

    const hashrateMhs = minerStats.hashrateByGroup[groupName] || 0
    const powerKw = dcsPowerByGroup[groupName]
      ? Math.round(dcsPowerByGroup[groupName] * 100) / 100
      : Math.round((minerStats.powerByGroup[groupName] || 0) / 10) / 100 // W to kW

    const hashrateThs = mhsToThs(hashrateMhs)
    const efficiency = hashrateThs > 0
      ? Math.round(((powerKw * 1000) / hashrateThs) * 10) / 10
      : minerStats.efficiencyByGroup[groupName] || 0

    const offline = minerStats.offlineByGroup[groupName] || 0
    const error = minerStats.errorByGroup[groupName] || 0
    const sleep = minerStats.sleepByGroup[groupName] || 0
    const low = minerStats.lowByGroup[groupName] || 0
    const normal = minerStats.normalByGroup[groupName] || 0
    const high = minerStats.highByGroup[groupName] || 0
    const notMining = minerStats.notMiningByGroup[groupName] || 0
    const totalMiners = offline + error + sleep + low + normal + high + notMining
    const empty = Math.max(0, minersPerGroup - totalMiners)

    const racks = buildRacksForGroup(groupName, minerStats, racksPerGroup)

    groups.push({
      id: groupName,
      name: `Group ${i}`,
      summary: {
        efficiency: { value: efficiency, unit: 'W/TH/s' },
        consumption: { value: powerKw, unit: 'kW' },
        hashrate: { value: mhsToPhs(hashrateMhs), unit: 'PH/s' }
      },
      racks,
      status: {
        offline,
        error,
        sleep,
        low,
        normal,
        high,
        empty,
        not_mining: notMining,
        total: totalMiners
      }
    })
  }

  return { groups }
}

/**
 * GET /auth/site/overview/groups
 *
 * Returns group-level stats combining:
 * - Miner stats from tailLog (hashrate, efficiency, status counts per group/rack)
 * - DCS power meter data for consumption
 */
async function getSiteOverviewGroupsStats (ctx, req) {
  const tailLogPayload = {
    keys: [
      { key: LOG_KEYS.STAT_RTD, type: WORKER_TYPES.MINER, tag: WORKER_TAGS.MINER }
    ],
    limit: 1,
    aggrFields: SITE_OVERVIEW_AGGR_FIELDS
  }

  const dcsEnabled = isCentralDCSEnabled(ctx)
  let dcsPayload = null
  if (dcsEnabled) {
    const dcsTag = getDCSTag(ctx)
    dcsPayload = {
      query: { tags: { $in: [dcsTag] } },
      status: 1,
      fields: { id: 1, code: 1, type: 1, tags: 1, ...DCS_POWER_METER_FIELDS }
    }
  }

  const [tailLogResults, dcsResults] = await Promise.all([
    ctx.dataProxy.requestDataMap('tailLogMulti', tailLogPayload),
    dcsEnabled ? ctx.dataProxy.requestDataMap('listThings', dcsPayload) : Promise.resolve(null)
  ])

  const minerStats = aggregateOverviewMinerStats(tailLogResults)

  const dcsThing = dcsResults ? extractDcsThing(dcsResults) : null

  const totalGroups = dcsThing?.last?.snap?.config?.mining?.total_groups || null

  return composeGroupsStats(minerStats, dcsThing, totalGroups)
}

function composeSiteEfficiency (minerStats, dcsThing) {
  const config = dcsThing?.last?.snap?.config || {}
  const miningConfig = config.mining || {}
  const energyLayout = config.energy_layout || {}
  const powerMeters = dcsThing?.last?.snap?.stats?.dcs_specific?.equipment?.power_meters || []
  const distributionBoards = dcsThing?.last?.snap?.stats?.dcs_specific?.equipment?.distribution_boards || []
  const transformers = dcsThing?.last?.snap?.stats?.dcs_specific?.equipment?.transformers || []
  const branches = energyLayout.branches || []

  const minersPerGroup = (miningConfig.racks_per_group || 4) * (miningConfig.miners_per_rack || 20)
  const siteMeter = powerMeters.find(pm => pm.equipment === energyLayout.site_meter) || powerMeters.find(pm => pm.role === 'site_main')
  const siteTotalKw = siteMeter?.power?.value || 0
  const powerUnit = siteMeter?.power?.unit

  const efficiencyPerMeter = []
  let totalMiningPowerKw = 0
  let totalHashrateMhs = 0

  for (const branch of branches) {
    const meter = powerMeters.find(pm => pm.equipment === branch.meter)
    if (!meter || meter.role !== 'rack') continue

    const meterPower = meter.power?.value || 0
    const coveredGroups = []
    const feedsMatch = branch.feeds?.match(/Groups?\s+(\d+)-(\d+)/i)
    if (feedsMatch) {
      const start = parseInt(feedsMatch[1], 10)
      const end = parseInt(feedsMatch[2], 10)
      for (let i = start; i <= end; i++) {
        coveredGroups.push(`group-${i}`)
      }
    }

    let branchHashrateMhs = 0
    for (const groupName of coveredGroups) {
      branchHashrateMhs += minerStats.hashrateByGroup[groupName] || 0
    }

    const branchHashrateThs = mhsToThs(branchHashrateMhs)
    const efficiency = branchHashrateThs > 0
      ? Math.round(((meterPower * 1000) / branchHashrateThs) * 100) / 100
      : 0

    totalMiningPowerKw += meterPower
    totalHashrateMhs += branchHashrateMhs

    const board = distributionBoards.find(db => db.equipment === branch.board)
    const transformer = transformers.find(tr => tr.equipment === branch.transformer)

    efficiencyPerMeter.push({
      board: branch.board,
      board_name: board?.name || branch.board,
      transformer: branch.transformer,
      transformer_name: transformer?.name || branch.transformer,
      feeds: branch.feeds,
      meter: branch.meter,
      efficiency: { value: efficiency, unit: 'W/THs' },
      power: { value: Math.round(meterPower * 10) / 10, unit: powerUnit },
      hashrate: { value: mhsToPhs(branchHashrateMhs), unit: 'PH/s' },
      miners: coveredGroups.length * minersPerGroup
    })
  }

  // Site-level efficiency
  const totalHashrateThs = mhsToThs(totalHashrateMhs)
  const siteEfficiency = totalHashrateThs > 0
    ? Math.round(((siteTotalKw * 1000) / totalHashrateThs) * 100) / 100
    : 0
  const miningEfficiency = totalHashrateThs > 0
    ? Math.round(((totalMiningPowerKw * 1000) / totalHashrateThs) * 100) / 100
    : 0

  // C&A overhead
  const ccmBranch = branches.find(b => b.feeds && !b.feeds.match(/Groups?\s+/i))
  const ccmMeter = ccmBranch ? powerMeters.find(pm => pm.equipment === ccmBranch.meter) : null
  const ccmPowerKw = ccmMeter?.power?.value || 0
  const caOverhead = siteTotalKw > 0
    ? Math.round((ccmPowerKw / siteTotalKw) * 1000) / 10
    : 0

  // Consumption breakdown
  const consumptionBreakdown = []

  if (siteMeter) {
    consumptionBreakdown.push({
      source: siteMeter.name || siteMeter.equipment,
      board: null,
      meter: siteMeter.equipment,
      consumption: { value: Math.round(siteTotalKw * 10) / 10, unit: powerUnit },
      percent: 100
    })
  }

  for (const branch of branches) {
    const meter = powerMeters.find(pm => pm.equipment === branch.meter)
    if (!meter) continue
    const meterPower = meter.power?.value || 0
    consumptionBreakdown.push({
      source: branch.board,
      board: branch.board,
      feeds: branch.feeds,
      meter: branch.meter,
      consumption: { value: Math.round(meterPower * 10) / 10, unit: powerUnit },
      percent: siteTotalKw > 0 ? Math.round((meterPower / siteTotalKw) * 1000) / 10 : 0
    })
  }

  return {
    summary: {
      site_efficiency: { value: siteEfficiency, unit: 'W/THs' },
      mining_efficiency: { value: miningEfficiency, unit: 'W/THs' },
      total_consumption: { value: Math.round((siteTotalKw / 1000) * 1000) / 1000, unit: 'MW' },
      ca_overhead: { value: caOverhead, unit: '%' }
    },
    efficiency_per_meter: efficiencyPerMeter,
    consumption_breakdown: consumptionBreakdown
  }
}

/**
 * GET /auth/site/efficiency
 *
 * Returns site efficiency metrics combining:
 * - Miner hashrate stats from tailLog (per group)
 * - DCS power meters, distribution boards, transformers for branch-level power
 */
async function getSiteEfficiency (ctx, req) {
  const tailLogPayload = {
    keys: [
      { key: LOG_KEYS.STAT_RTD, type: WORKER_TYPES.MINER, tag: WORKER_TAGS.MINER }
    ],
    limit: 1,
    aggrFields: SITE_OVERVIEW_AGGR_FIELDS
  }

  const dcsEnabled = isCentralDCSEnabled(ctx)
  let dcsPayload = null
  if (dcsEnabled) {
    const dcsTag = getDCSTag(ctx)
    dcsPayload = {
      query: { tags: { $in: [dcsTag] } },
      status: 1,
      fields: { id: 1, code: 1, type: 1, tags: 1, ...DCS_EFFICIENCY_FIELDS }
    }
  }

  const [tailLogResults, dcsResults] = await Promise.all([
    ctx.dataProxy.requestDataMap('tailLogMulti', tailLogPayload),
    dcsEnabled ? ctx.dataProxy.requestDataMap('listThings', dcsPayload) : Promise.resolve(null)
  ])

  const minerStats = aggregateOverviewMinerStats(tailLogResults)
  const dcsThing = dcsResults ? extractDcsThing(dcsResults) : null

  if (!dcsThing) {
    throw new Error('ERR_DCS_DATA_NOT_FOUND')
  }

  return composeSiteEfficiency(minerStats, dcsThing)
}

module.exports = {
  getSiteLiveStatus,
  getSiteOverviewGroupsStats,
  getSiteEfficiency
}
