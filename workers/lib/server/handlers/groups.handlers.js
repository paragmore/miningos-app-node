'use strict'

const {
  LOG_KEYS,
  WORKER_TYPES,
  WORKER_TAGS,
  EXPLORER_RACK_AGGR_FIELDS,
  DCS_POWER_METER_FIELDS
} = require('../../constants')
const {
  aggregateRackStats,
  buildRackList
} = require('./explorer.handlers')
const { rackFilterFor } = require('../../metrics.utils')
const {
  isCentralDCSEnabled,
  getDCSTag,
  extractDcsThing
} = require('../../dcs.utils')
const { parseRacks } = require('../lib/queryUtils')

async function getGroupStats (ctx, req) {
  const requestedRacks = parseRacks(req)
  if (!requestedRacks || !requestedRacks.length) {
    throw new Error('ERR_MISSING_RACKS')
  }

  const tailLogPayload = {
    keys: [
      { key: LOG_KEYS.STAT_RTD, type: WORKER_TYPES.MINER, tag: WORKER_TAGS.MINER }
    ],
    limit: 1,
    aggrFields: EXPLORER_RACK_AGGR_FIELDS
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

  const rackStats = aggregateRackStats(tailLogResults)
  const dcsThing = dcsResults ? extractDcsThing(dcsResults) : null
  const miningConfig = dcsThing?.last?.snap?.config?.mining || {}

  const matchesRequested = rackFilterFor(requestedRacks)
  const data = buildRackList(miningConfig, rackStats).filter(rack => matchesRequested(rack.id))

  return {
    data,
    totalCount: data.length
  }
}

module.exports = {
  getGroupStats
}
