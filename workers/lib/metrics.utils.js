'use strict'

const { getStartOfDay } = require('./period.utils')
const { METRICS_TIME, LOG_KEYS } = require('./constants')

/**
 * Parse timestamp from RPC entry.
 * With groupRange, ts may be a range string like "1770854400000-1771459199999".
 * Extracts the start of the range in that case.
 */
function parseEntryTs (ts) {
  if (typeof ts === 'number') return ts
  if (typeof ts === 'string') {
    const dashIdx = ts.indexOf('-')
    if (dashIdx > 0) return Number(ts.slice(0, dashIdx))
    return Number(ts)
  }
  return null
}

function parseEntryTimeRange (ts) {
  if (typeof ts !== 'string') return null
  const dashIdx = ts.indexOf('-')
  if (dashIdx <= 0) return null
  const startTs = Number(ts.slice(0, dashIdx))
  const endTs = Number(ts.slice(dashIdx + 1))
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return null
  return { startTs, endTs }
}

function validateStartEnd (req) {
  const start = Number(req.query.start)
  const end = Number(req.query.end)

  if (!start || !end) {
    throw new Error('ERR_MISSING_START_END')
  }

  if (start >= end) {
    throw new Error('ERR_INVALID_DATE_RANGE')
  }

  return { start, end }
}

function * iterateRpcEntries (results) {
  for (const res of results) {
    if (!res || res.error) continue
    const data = Array.isArray(res) ? res : (res.data || res.result || [])
    if (!Array.isArray(data)) continue
    for (const entry of data) {
      if (!entry || entry.error) continue
      yield entry
    }
  }
}

function forEachRangeAggrItem (entry, callback) {
  if (!entry) return
  const items = entry.data || entry.items || entry
  if (Array.isArray(items)) {
    for (const item of items) {
      const ts = getStartOfDay(parseEntryTs(item.ts || item.timestamp))
      if (!ts) continue
      callback(ts, item.val || item)
    }
  } else if (typeof items === 'object') {
    for (const [key, val] of Object.entries(items)) {
      const ts = getStartOfDay(parseEntryTs(Number(key)))
      if (!ts) continue
      callback(ts, val)
    }
  }
}

function sumObjectValues (obj) {
  if (!obj || typeof obj !== 'object') return 0
  return Object.values(obj).reduce((sum, val) => sum + (Number(val) || 0), 0)
}

/**
 * Extract container name from a device key.
 * Strips the last dash-separated segment (assumed to be position/index).
 * e.g. "bitdeer-9a-miner1" -> "bitdeer-9a"
 * NOTE: This is a heuristic based on naming convention in power_mode_group_aggr data.
 * Device keys are identifiers from aggregated data, not auto-generated IDs.
 */
function extractContainerFromMinerKey (deviceKey) {
  const lastDash = deviceKey.lastIndexOf('-')
  return lastDash > 0 ? deviceKey.slice(0, lastDash) : deviceKey
}

function resolveInterval (start, end, requested) {
  if (requested) return requested
  const range = end - start
  if (range <= METRICS_TIME.TWO_DAYS_MS) return '1h'
  if (range <= METRICS_TIME.NINETY_DAYS_MS) return '1d'
  return '1w'
}

function getIntervalConfig (interval) {
  switch (interval) {
    case '1h':
      // Sample the finer-grained stat-30m log and bucket it into 1h windows,
      // so hourly views aren't coarsened to the 3h stat cadence.
      return { key: LOG_KEYS.STAT_30M, groupRange: '1H' }
    case '1w':
      return { key: LOG_KEYS.STAT_3H, groupRange: '1W' }
    case '1M': // 30-day month; distinct from 1m (one minute)
      return { key: LOG_KEYS.STAT_3H, groupRange: '1M' }
    case '1d':
    default:
      return { key: LOG_KEYS.STAT_3H, groupRange: '1D' }
  }
}

function extractKeyEntry (orkResult, keyIndex) {
  if (!Array.isArray(orkResult)) return null
  const keyResult = orkResult[keyIndex]
  if (!Array.isArray(keyResult) || keyResult.length === 0) return null
  return keyResult[0] || null
}

// Hashrate conversion utilities
function mhsToPhs (mhs) {
  return Math.round((mhs / 1000000000) * 100) / 100
}

function mhsToThs (mhs) {
  return mhs / 1000000
}

// Rack/Group parsing utilities
function parseRackId (rackKey) {
  if (!rackKey || typeof rackKey !== 'string') return null
  const idx = rackKey.indexOf('_')
  if (idx === -1) return null
  return {
    group: rackKey.substring(0, idx),
    rack: rackKey.substring(idx + 1)
  }
}

function getGroupNumber (groupName) {
  const match = groupName.match(/group-(\d+)/i)
  return match ? parseInt(match[1], 10) : null
}

// The '*_pdu_rack_group_*' aggregations are keyed by physical position ('group-1_1-1'), while
// the rack grid is addressed by slot ('group-1_rack-1'). Both spellings reduce to group+ordinal.
function rackSlotKey (rackId) {
  const parsed = parseRackId(rackId)
  if (!parsed) return null
  const match = /(\d+)\s*$/.exec(parsed.rack)
  return match ? `${parsed.group}#${parseInt(match[1], 10)}` : null
}

function rackKeysByGroupOrdinal (...rackMaps) {
  const keysByGroup = new Map()

  for (const rackMap of rackMaps) {
    for (const rackKey of Object.keys(rackMap || {})) {
      const parsed = parseRackId(rackKey)
      if (!parsed) continue
      if (!keysByGroup.has(parsed.group)) keysByGroup.set(parsed.group, new Set())
      keysByGroup.get(parsed.group).add(rackKey)
    }
  }

  const byGroupOrdinal = new Map()
  for (const [groupId, rackKeys] of keysByGroup) {
    const byOrdinal = new Map()
    ;[...rackKeys]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .forEach((rackKey, idx) => {
        const slot = rackSlotKey(rackKey)
        const ordinal = slot ? Number(slot.split('#')[1]) : idx + 1
        if (!byOrdinal.has(ordinal)) byOrdinal.set(ordinal, rackKey)
      })
    byGroupOrdinal.set(groupId, byOrdinal)
  }

  return byGroupOrdinal
}

function rackFilterFor (racks) {
  if (!racks?.length) return null
  const slots = new Set(racks.map(rackSlotKey).filter(Boolean))
  return (rackId) => slots.has(rackSlotKey(rackId))
}

function mergeGroupedField (target, source, isAverage = false) {
  if (!source || typeof source !== 'object') return

  for (const [key, value] of Object.entries(source)) {
    if (isAverage) {
      if (!target[key] || value > target[key]) {
        target[key] = value
      }
    } else {
      target[key] = (target[key] || 0) + (value || 0)
    }
  }
}

// DCS power meter utilities
function getMeterGroupMapping (meterId, energyLayout) {
  const branches = energyLayout?.branches || []

  for (const branch of branches) {
    if (branch.meter === meterId && branch.feeds) {
      const match = branch.feeds.match(/Groups?\s+(\d+)-(\d+)/i)
      if (match) {
        const start = parseInt(match[1], 10)
        const end = parseInt(match[2], 10)
        const groups = []
        for (let i = start; i <= end; i++) {
          groups.push(`group-${i}`)
        }
        return groups
      }
    }
  }
  return []
}

function buildGroupPowerFromDCS (powerMeters, hashrateByGroup, energyLayout, miningConfig) {
  const groupPower = {}

  const rackMeters = (powerMeters || []).filter(pm => pm.role === 'rack')

  for (const meter of rackMeters) {
    const meterPower = meter.power?.value || 0
    const coveredGroups = getMeterGroupMapping(meter.equipment, energyLayout)

    if (coveredGroups.length === 0 || meterPower === 0) continue

    let totalHashrate = 0
    for (const groupName of coveredGroups) {
      totalHashrate += hashrateByGroup[groupName] || 0
    }

    if (totalHashrate > 0) {
      for (const groupName of coveredGroups) {
        const groupHashrate = hashrateByGroup[groupName] || 0
        const proportion = groupHashrate / totalHashrate
        groupPower[groupName] = (groupPower[groupName] || 0) + (meterPower * proportion)
      }
    } else {
      const perGroup = meterPower / coveredGroups.length
      for (const groupName of coveredGroups) {
        groupPower[groupName] = (groupPower[groupName] || 0) + perGroup
      }
    }
  }

  return groupPower
}

module.exports = {
  parseEntryTs,
  parseEntryTimeRange,
  validateStartEnd,
  iterateRpcEntries,
  forEachRangeAggrItem,
  sumObjectValues,
  extractContainerFromMinerKey,
  extractKeyEntry,
  resolveInterval,
  getIntervalConfig,
  mhsToPhs,
  mhsToThs,
  parseRackId,
  getGroupNumber,
  rackSlotKey,
  rackKeysByGroupOrdinal,
  rackFilterFor,
  mergeGroupedField,
  getMeterGroupMapping,
  buildGroupPowerFromDCS
}
