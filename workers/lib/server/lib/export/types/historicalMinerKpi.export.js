'use strict'

const { formatDateTime } = require('../mappers')

const STAT_KEYS = ['stat-1m', 'stat-5m', 'stat-3h']

const FIELDS = {
  hashrate_mhs_1m_sum: 1,
  power_w_sum: 1,
  power_w_group: 1,
  power_mode_group: 1,
  hashrate_mhs_1m_group: 1,
  status_group: 1,
  container_specific_stats_group: 1
}

const AGGR_FIELDS = {
  hashrate_mhs_1m_sum_aggr: 1,
  power_w_sum_aggr: 1,
  power_w_group_aggr: 1,
  power_mode_group_aggr: 1,
  hashrate_mhs_1m_group_aggr: 1,
  status_group_aggr: 1,
  container_specific_stats_group_aggr: 1
}

function sumGabbaniStats (containerLog) {
  const sums = {
    sumProductionPower: 0,
    sumConsumptionPower: 0,
    sumSystemConsumptionPower: 0
  }
  const byContainer = containerLog?.container_specific_stats_group_aggr || {}
  for (const [key, stats] of Object.entries(byContainer)) {
    if (!String(key).toLowerCase().includes('gabbani')) continue
    sums.sumProductionPower += stats?.production_power_w ?? 0
    sums.sumConsumptionPower += stats?.consumption_power_w ?? 0
    sums.sumSystemConsumptionPower += stats?.system_consumption_power_w ?? 0
  }
  return sums
}

function attributeColumns (attributeLog, title) {
  const columns = {}
  for (const [minerKey, value] of Object.entries(attributeLog || {})) {
    columns[`${title} ${minerKey}`] = value
  }
  return columns
}

module.exports = {
  type: 'historical-miner-kpi',
  perms: null,
  jsonRootKey: 'logs',
  columns: null,
  statKeys: STAT_KEYS,
  filenamePrefix (params) {
    return `historical_mining_stats_${String(params.statKey).replace(/^stat-/, '')}_`
  },
  assertParams (params) {
    if (!STAT_KEYS.includes(params.statKey)) throw new Error('ERR_EXPORT_STAT_KEY_REQUIRED')
    if (!Number.isFinite(params.start) || !Number.isFinite(params.end)) {
      throw new Error('ERR_EXPORT_RANGE_REQUIRED')
    }
    if (params.start > params.end) throw new Error('ERR_EXPORT_RANGE_INVALID')
  },
  async fetchExport (ctx, { params, now, timezone }) {
    const results = await ctx.dataProxy.requestDataMap('tailLogMulti', {
      keys: [
        { key: params.statKey, type: 'miner', tag: 't-miner' },
        { key: params.statKey, type: 'container', tag: 't-container' }
      ],
      start: params.start,
      end: params.end,
      fields: FIELDS,
      aggrFields: AGGR_FIELDS
    })

    const series = Array.isArray(results?.[0]) ? results[0] : []
    const minerLogs = Array.isArray(series[0]) ? series[0] : []
    const containerLogs = Array.isArray(series[1]) ? series[1] : []

    const containerByTs = new Map()
    for (const log of containerLogs) {
      if (log) containerByTs.set(log.ts, log)
    }
    const minerRows = minerLogs
      .filter((log) => log && log.ts)
      .sort((a, b) => b.ts - a.ts)

    async function * rows () {
      for (const log of minerRows) {
        const gabbani = sumGabbaniStats(containerByTs.get(log.ts))
        yield {
          time: formatDateTime(new Date(log.ts), timezone),
          totalMinersHashrateMHS: log.hashrate_mhs_1m_sum_aggr,
          totalMinerPowerW: log.power_w_sum_aggr,
          ...attributeColumns(log.power_mode_group_aggr, 'Power Mode'),
          ...attributeColumns(log.status_group_aggr, 'Status'),
          totalSystemConsumptionW: (log.power_w_sum_aggr || 0) + gabbani.sumSystemConsumptionPower,
          gridExportPowerW: gabbani.sumProductionPower,
          gridImportPowerW: gabbani.sumConsumptionPower
        }
      }
    }
    return {
      rows: rows(),
      jsonMeta: { dateExported: formatDateTime(now, timezone) }
    }
  }
}
