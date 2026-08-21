'use strict'

const { TEMPERATURE_COLUMNS, mapTemperatureColumns, splitPoolWorker } = require('../mappers')
const { pagedListThings } = require('./pagedListThings')

const FIELDS = {
  id: 1,
  type: 1,
  code: 1,
  info: 1,
  address: 1,
  rack: 1,
  'last.snap.stats.status': 1,
  'last.snap.stats.are_all_errors_minor': 1,
  'last.snap.config.power_mode': 1,
  'last.snap.stats.hashrate': 1,
  'last.snap.stats.hashrate_mhs': 1,
  'last.snap.stats.temperature_c': 1,
  'last.snap.stats.frequency_mhz': 1,
  'last.snap.stats.power_w': 1,
  'last.snap.stats.miner_specific.power_pct': 1,
  'last.snap.stats.uptime_ms': 1,
  'last.snap.config.led_status': 1,
  'last.snap.config.firmware_ver': 1,
  'last.snap.config.pool_config': 1,
  'last.alerts': 1
}

// Kept column-compatible with minerStats.export.js — ops diff the two.
const COLUMNS = [
  'id', 'type', 'site', 'container', 'position', 'serialNumber', 'macAddress',
  'ipAddress', 'firmwareVersion', 'status', 'powerMode', 'hashrateMhs',
  'efficiencyWThs', 'powerW', 'temperatureC', 'workerName', 'activePool',
  'alerts', 'uptimeMs',
  ...TEMPERATURE_COLUMNS
]

function efficiencyWThs (powerW, hashrateMhs) {
  if (!powerW || !hashrateMhs || hashrateMhs <= 0) return ''
  return powerW / (hashrateMhs / 1e6)
}

function mapMiner (miner) {
  const snap = miner?.last?.snap
  const stats = snap?.stats
  const poolConfig = snap?.config?.pool_config
  const username = Array.isArray(poolConfig) ? poolConfig[0]?.username : undefined
  const { poolName, workerName } = splitPoolWorker(username)
  const hashrateMhs = stats?.hashrate_mhs?.t_5m

  return {
    id: miner?.id,
    type: miner?.type,
    site: miner?.info?.site,
    container: miner?.info?.container,
    position: miner?.info?.pos,
    serialNumber: miner?.info?.serialNum,
    macAddress: miner?.info?.macAddress,
    ipAddress: miner?.address,
    firmwareVersion: snap?.config?.firmware_ver,
    status: stats?.status,
    powerMode: snap?.config?.power_mode,
    hashrateMhs,
    efficiencyWThs: efficiencyWThs(stats?.power_w, hashrateMhs),
    powerW: stats?.power_w,
    temperatureC: stats?.temperature_c,
    workerName,
    activePool: poolName,
    alerts: miner?.last?.alerts,
    uptimeMs: stats?.uptime_ms,
    ...mapTemperatureColumns(stats?.temperature_c)
  }
}

module.exports = {
  type: 'container-miner-stats',
  perms: ['reporting:r'],
  jsonRootKey: 'miners',
  columns: COLUMNS,
  filenamePrefix () {
    return 'container_miners_stats_'
  },
  assertParams (params) {
    if (!params.container) throw new Error('ERR_EXPORT_CONTAINER_REQUIRED')
  },
  async fetchExport (ctx, { params, now }) {
    const query = {
      $and: [
        { tags: { $in: [`container-${params.container}`] } },
        { tags: { $in: ['t-miner'] } }
      ]
    }
    async function * rows () {
      for await (const thing of pagedListThings(ctx, query, FIELDS)) {
        yield mapMiner(thing)
      }
    }
    return {
      rows: rows(),
      jsonMeta: { dateExported: now.toISOString() }
    }
  }
}
