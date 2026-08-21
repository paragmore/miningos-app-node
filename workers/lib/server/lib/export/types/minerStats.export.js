'use strict'

const {
  TEMPERATURE_COLUMNS,
  getMinerShortCode,
  mapTemperatureColumns,
  splitPoolWorker
} = require('../mappers')
const { pagedListThings } = require('./pagedListThings')

const FIELDS = {
  id: 1,
  tags: 1,
  info: 1,
  type: 1,
  'opts.address': 1,
  'last.snap.config.pool_config': 1,
  'last.snap.stats.status': 1,
  'last.snap.config.power_mode': 1,
  'last.snap.config.network_config.ip_address': 1,
  'last.snap.stats.hashrate_mhs.t_5m': 1,
  'last.snap.stats.power_w': 1,
  'last.snap.stats.temperature_c': 1,
  'last.snap.stats.miner_specific.liquid_temp': 1,
  'last.alerts': 1,
  'last.snap.stats.uptime_ms': 1
}

const QUERY = { tags: { $in: ['t-miner'] } }

// Appended, never reordered: consumers read this CSV both by header name and
// by column position, so inserting mid-list would break the positional ones.
const COLUMNS = [
  'id', 'status', 'powerMode', 'site', 'container', 'position', 'shortCode',
  'hashrateMhs', 'powerW', 'workerName', 'activePool', 'serialNumber',
  'macAddress', 'type', 'temperatureC', 'alerts', 'uptimeMs', 'ip',
  ...TEMPERATURE_COLUMNS
]

function mapMiner (miner) {
  const snap = miner?.last?.snap
  const poolConfig = snap?.config?.pool_config
  const username = Array.isArray(poolConfig) ? poolConfig[0]?.username : undefined
  const { poolName, workerName } = splitPoolWorker(username)

  return {
    id: miner?.id,
    status: snap?.stats?.status,
    powerMode: snap?.config?.power_mode,
    site: miner?.info?.site,
    container: miner?.info?.container,
    position: miner?.info?.pos,
    shortCode: getMinerShortCode(miner?.code, miner?.tags),
    hashrateMhs: snap?.stats?.hashrate_mhs?.t_5m,
    powerW: snap?.stats?.power_w,
    workerName,
    activePool: poolName,
    serialNumber: miner?.info?.serialNum,
    macAddress: miner?.info?.macAddress,
    type: miner?.type,
    temperatureC: snap?.stats?.temperature_c,
    alerts: miner?.last?.alerts,
    uptimeMs: snap?.stats?.uptime_ms,
    ip: miner?.address,
    ...mapTemperatureColumns(snap?.stats)
  }
}

module.exports = {
  type: 'miner-stats',
  perms: ['reporting:r'],
  jsonRootKey: 'miners',
  columns: COLUMNS,
  filenamePrefix () {
    return 'realtime_miners_stats_'
  },
  assertParams () {},
  async fetchExport (ctx, { now }) {
    async function * rows () {
      for await (const thing of pagedListThings(ctx, QUERY, FIELDS)) {
        yield mapMiner(thing)
      }
    }
    return {
      rows: rows(),
      jsonMeta: { dateExported: now.toISOString() }
    }
  }
}
