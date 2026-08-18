'use strict'

const test = require('brittle')
const {
  getHashrate,
  calculateHashrateSummary,
  getConsumption,
  calculateConsumptionSummary,
  calculateByMeterConsumptionSummary,
  calculateGroupedConsumptionSummary,
  getEfficiency,
  calculateEfficiencySummary,
  calculateGroupedEfficiencySummary,
  getMinerStatus,
  getMinersByContainer,
  getInventorySummary,
  processMinerStatusData,
  processGroupedMinerStatusData,
  calculateMinerStatusSummary,
  sumObjectValues,
  parseEntryTs,
  parseEntryTimeRange,
  resolveInterval,
  getIntervalConfig,
  getPowerMode,
  processPowerModeData,
  calculatePowerModeSummary,
  categorizeMiner,
  getPowerModeTimeline,
  processPowerModeTimelineData,
  resolvePowerModeTimelineInterval,
  getTemperature,
  processTemperatureData,
  calculateTemperatureSummary,
  forEachRangeAggrItem,
  getContainerTelemetry,
  processContainerMiners,
  processContainerSensorSnapshot,
  getContainerHistory,
  processContainerHistoryData,
  getMinersByType,
  processMinersByType,
  getInventoryMinerDistribution,
  computeInstalledCapacity
} = require('../../../workers/lib/server/handlers/metrics.handlers')
const { withDataProxy } = require('../helpers/mockHelpers')

// ==================== Hashrate Tests ====================

test('getHashrate - happy path', async (t) => {
  const dayTs = 1700006400000
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }]
    },
    net_r0: {
      jRequest: async () => {
        return [{ ts: dayTs, hashrate_mhs_5m_sum_aggr: 100000 }]
      }
    }
  })

  const mockReq = {
    query: { start: 1700000000000, end: 1700100000000 }
  }

  const result = await getHashrate(mockCtx, mockReq)
  t.ok(result.log, 'should return log array')
  t.ok(result.summary, 'should return summary')
  t.ok(Array.isArray(result.log), 'log should be array')
  t.ok(result.log.length > 0, 'log should have entries')
  t.is(result.log[0].hashrateMhs, 100000, 'should have hashrate value')
  t.ok(result.summary.avgHashrateMhs !== null, 'should have avg hashrate')
  t.pass()
})

test('getHashrate - container filter reads that container from the group aggregate', async (t) => {
  let capturedPayload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [{
          ts: 1700006400000,
          hashrate_mhs_5m_container_group_sum_aggr: { 'container-A': 500, 'container-B': 277 }
        }]
      }
    }
  })

  const result = await getHashrate(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, container: 'container-A' }
  })

  t.is(capturedPayload.aggrFields.hashrate_mhs_5m_container_group_sum_aggr, 1, 'should request the container-group aggregate')
  t.is(result.log[0].hashrateMhs, 500, 'should read only the requested container')
  t.is(result.summary.avgHashrateMhs, 500, 'summary should cover the requested container only')
  t.absent('currentHashrateMhs' in result.summary, 'should not add current unless asked')
  t.pass()
})

test('getHashrate - unknown container yields zeroes, not a crash', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async () => [{ ts: 1700006400000, hashrate_mhs_5m_container_group_sum_aggr: { 'container-A': 500 } }]
    }
  })

  const result = await getHashrate(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, container: 'nope' }
  })

  t.is(result.log[0].hashrateMhs, 0, 'should fall back to 0')
  t.pass()
})

test('getHashrate - current adds the latest stat-rtd value', async (t) => {
  const calls = []
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        calls.push(payload)
        if (payload.key === 'stat-rtd') return [{ hashrate_mhs_5m_sum_aggr: 987 }]
        return [{ ts: 1700006400000, hashrate_mhs_5m_sum_aggr: 100000 }]
      }
    }
  })

  const result = await getHashrate(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, current: true }
  })

  t.is(calls.length, 2, 'should make a second call for the live value')
  t.is(calls[1].limit, 1, 'should read a single rtd sample')
  t.is(result.log[0].hashrateMhs, 100000, 'series should be unchanged')
  t.is(result.summary.currentHashrateMhs, 987, 'should expose the rtd value')
  t.pass()
})

test('getHashrate - current with container reads that container rtd value', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (payload.key === 'stat-rtd') {
          return [{ hashrate_mhs_5m_container_group_sum_aggr: { 'container-A': 42 } }]
        }
        return [{ ts: 1700006400000, hashrate_mhs_5m_container_group_sum_aggr: { 'container-A': 500 } }]
      }
    }
  })

  const result = await getHashrate(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, container: 'container-A', current: true }
  })

  t.is(result.summary.currentHashrateMhs, 42, 'should read the container rtd value')
  t.pass()
})

test('getHashrate - current is null when no rtd sample is in the window', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (payload.key === 'stat-rtd') return []
        return [{ ts: 1700006400000, hashrate_mhs_5m_sum_aggr: 100000 }]
      }
    }
  })

  const result = await getHashrate(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, current: true }
  })

  t.is(result.summary.currentHashrateMhs, null, 'should be null rather than 0')
  t.pass()
})

test('getHashrate - grouped by miner uses type group aggregation', async (t) => {
  let capturedPayload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [{
          ts: 1700006400000,
          hashrate_mhs_5m_type_group_sum_aggr: { 'S19-Pro': 100000, S21: 23456 }
        }]
      }
    }
  })

  const result = await getHashrate(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, groupBy: 'miner' }
  })

  t.is(capturedPayload.fields.hashrate_mhs_5m_type_group_sum, 1, 'should request type-group source field')
  t.is(capturedPayload.aggrFields.hashrate_mhs_5m_type_group_sum_aggr, 1, 'should request type-group aggregate field')
  t.is(result.log.length, 1, 'should map one grouped row')
  t.alike(result.log[0].hashrateMhs, { 'S19-Pro': 100000, S21: 23456 }, 'should map grouped hashrate value')
  t.is(result.summary.avgHashrateMhs, 123456, 'should have site-wide average')
  t.is(result.summary.groupedBy['S19-Pro'].avgHashrateMhs, 100000, 'should have per-miner average')
  t.is(result.summary.groupedBy.S21.avgHashrateMhs, 23456, 'should have per-miner average')
  t.absent('totalHashrateMhs' in result.summary, 'summary should not expose a time-summed total')
  t.pass()
})

test('getHashrate - grouped by container uses container group aggregation', async (t) => {
  let capturedPayload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [{
          ts: 1700006400000,
          hashrate_mhs_5m_container_group_sum_aggr: { 'container-A': 500, 'container-B': 277 }
        }]
      }
    }
  })

  const result = await getHashrate(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, groupBy: 'container' }
  })

  t.is(capturedPayload.fields.hashrate_mhs_5m_container_group_sum, 1, 'should request container-group source field')
  t.is(capturedPayload.aggrFields.hashrate_mhs_5m_container_group_sum_aggr, 1, 'should request container-group aggregate field')
  t.is(result.log.length, 1, 'should map grouped row')
  t.alike(result.log[0].hashrateMhs, { 'container-A': 500, 'container-B': 277 }, 'should map container grouped hashrate value')
  t.is(result.summary.avgHashrateMhs, 777, 'should have site-wide average')
  t.is(result.summary.groupedBy['container-A'].avgHashrateMhs, 500, 'should have per-container average')
  t.is(result.summary.groupedBy['container-B'].avgHashrateMhs, 277, 'should have per-container average')
  t.pass()
})

test('getHashrate - grouped by rack uses rack group aggregation', async (t) => {
  let capturedPayload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [{
          ts: 1700006400000,
          hashrate_mhs_5m_pdu_rack_group_sum_aggr: {
            'group-1_rack-1': 1000, 'group-1_rack-2': 2000, 'group-2_rack-1': 3000
          }
        }]
      }
    }
  })

  const result = await getHashrate(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, groupBy: 'rack' }
  })

  t.is(capturedPayload.fields.hashrate_mhs_5m_pdu_rack_group_sum, 1, 'should request rack-group source field')
  t.is(capturedPayload.aggrFields.hashrate_mhs_5m_pdu_rack_group_sum_aggr, 1, 'should request rack-group aggregate field')
  t.is(result.log.length, 1, 'should map grouped row')
  t.alike(result.log[0].hashrateMhs, { 'group-1_rack-1': 1000, 'group-1_rack-2': 2000, 'group-2_rack-1': 3000 }, 'should map all racks when no filter given')
  t.is(result.summary.avgHashrateMhs, 6000, 'should average all racks')
  t.is(result.summary.groupedBy['group-1_rack-1'].avgHashrateMhs, 1000, 'should have per-rack average')
  t.pass()
})

test('getHashrate - grouped by rack filters to requested racks', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async () => [{
        ts: 1700006400000,
        hashrate_mhs_5m_pdu_rack_group_sum_aggr: {
          'group-1_rack-1': 1000, 'group-1_rack-2': 2000, 'group-2_rack-1': 3000
        }
      }]
    }
  })

  const result = await getHashrate(mockCtx, {
    query: {
      start: 1700000000000,
      end: 1700100000000,
      groupBy: 'rack',
      racks: 'group-1_rack-1, group-2_rack-1'
    }
  })

  t.alike(result.log[0].hashrateMhs, { 'group-1_rack-1': 1000, 'group-2_rack-1': 3000 }, 'should keep only requested racks')
  t.absent(result.summary.groupedBy['group-1_rack-2'], 'filtered-out rack should be absent from summary')
  t.is(result.summary.avgHashrateMhs, 4000, 'summary should reflect filtered racks only')
  t.pass()
})

test('getHashrate - grouped by rack matches the real aggregation key spelling', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async () => [{
        ts: 1700006400000,
        hashrate_mhs_5m_pdu_rack_group_sum_aggr: {
          'group-1_1-1': 1000, 'group-1_1-2': 2000, 'group-2_2-1': 3000
        }
      }]
    }
  })

  const result = await getHashrate(mockCtx, {
    query: {
      start: 1700000000000,
      end: 1700100000000,
      groupBy: 'rack',
      racks: 'group-1_rack-1,group-2_rack-1'
    }
  })

  t.alike(result.log[0].hashrateMhs, { 'group-1_1-1': 1000, 'group-2_2-1': 3000 }, 'slot ids resolve to the real keys')
  t.pass()
})

test('getHashrate - racks without groupBy scopes the scalar series', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async () => [{
        ts: 1700006400000,
        hashrate_mhs_5m_pdu_rack_group_sum_aggr: {
          'group-1_1-1': 1000, 'group-1_1-2': 2000, 'group-2_2-1': 3000
        }
      }]
    }
  })

  const result = await getHashrate(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, racks: 'group-1_rack-1,group-1_rack-2' }
  })

  t.is(result.log[0].hashrateMhs, 3000, 'sums only the selected racks')
  t.is(result.summary.avgHashrateMhs, 3000)
  t.pass()
})

test('getHashrate - grouped mode handles empty results', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async () => [] }
  })

  const result = await getHashrate(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, groupBy: 'miner' }
  })

  t.is(result.log.length, 0, 'grouped log should be empty when no data is returned')
  t.is(result.summary.avgHashrateMhs, null, 'grouped empty summary should have null avg')
  t.pass()
})

test('getHashrate - missing start throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getHashrate(mockCtx, { query: { end: 1700100000000 } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_START_END', 'should throw missing start/end error')
  }
  t.pass()
})

test('getHashrate - missing end throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getHashrate(mockCtx, { query: { start: 1700000000000 } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_START_END', 'should throw missing start/end error')
  }
  t.pass()
})

test('getHashrate - invalid range throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getHashrate(mockCtx, { query: { start: 1700100000000, end: 1700000000000 } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_INVALID_DATE_RANGE', 'should throw invalid range error')
  }
  t.pass()
})

test('getHashrate - empty ork results', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async () => ({}) }
  })

  const result = await getHashrate(mockCtx, { query: { start: 1700000000000, end: 1700100000000 } })
  t.ok(result.log, 'should return log array')
  t.ok(result.summary, 'should return summary')
  t.is(result.log.length, 0, 'log should be empty with no data')
  t.is(result.summary.avgHashrateMhs, null, 'avg should be null')
  t.pass()
})

test('getHashrate - returns one entry per bucket without summing samples', async (t) => {
  let capturedPayload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [
          { ts: 1700006400000, hashrate_mhs_5m_sum_aggr: 100000 },
          { ts: 1700092800000, hashrate_mhs_5m_sum_aggr: 120000 }
        ]
      }
    }
  })

  const result = await getHashrate(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000 }
  })

  t.is(capturedPayload.shouldCalculateAvg, true, 'should ask the rack to average samples in the bucket')
  t.is(result.log.length, 2, 'should emit one entry per bucket')
  t.is(result.log[0].hashrateMhs, 100000, 'should read the bucket value as-is')
  t.is(result.log[1].hashrateMhs, 120000, 'should read the bucket value as-is')
  t.pass()
})

test('getHashrate - interval selects the bucket range', async (t) => {
  const captured = []
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        captured.push(payload)
        return []
      }
    }
  })

  const query = { start: 1700000000000, end: 1700100000000 }
  await getHashrate(mockCtx, { query: { ...query, interval: '1h' } })
  await getHashrate(mockCtx, { query: { ...query, interval: '1d' } })
  await getHashrate(mockCtx, { query: { ...query, interval: '1w' } })

  t.is(captured[0].groupRange, '1H', '1h should bucket hourly')
  t.is(captured[0].key, 'stat-30m', '1h should sample the stat-30m log')
  t.is(captured[1].groupRange, '1D', '1d should bucket daily')
  t.is(captured[2].groupRange, '1W', '1w should bucket weekly')
  t.pass()
})

test('calculateHashrateSummary - calculates from log entries', (t) => {
  const log = [
    { ts: 1700006400000, hashrateMhs: 100000 },
    { ts: 1700092800000, hashrateMhs: 120000 }
  ]

  const summary = calculateHashrateSummary(log)
  t.is(summary.avgHashrateMhs, 110000, 'should average hashrate')
  t.absent('totalHashrateMhs' in summary, 'should not expose a total that is just avg x bucket count')
  t.pass()
})

test('calculateHashrateSummary - handles empty log', (t) => {
  const summary = calculateHashrateSummary([])
  t.is(summary.avgHashrateMhs, null, 'should be null')
  t.pass()
})

// ==================== Consumption Tests ====================

test('getConsumption - happy path', async (t) => {
  const dayTs = 1700006400000
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }]
    },
    net_r0: {
      jRequest: async () => {
        return [{ ts: dayTs, site_power_w: 5000000 }]
      }
    }
  })

  const mockReq = {
    query: { start: 1700000000000, end: 1700100000000 }
  }

  const result = await getConsumption(mockCtx, mockReq)
  t.ok(result.log, 'should return log array')
  t.ok(result.summary, 'should return summary')
  t.ok(Array.isArray(result.log), 'log should be array')
  t.ok(result.log.length > 0, 'log should have entries')
  t.is(result.log[0].powerW, 5000000, 'should have power value')
  t.is(result.log[0].consumptionMWh, (5000000 * 1) / 1000000, 'should convert to MWh over the bucket span')
  t.ok(result.summary.avgPowerW !== null, 'should have avg power')
  t.ok(result.summary.totalConsumptionMWh > 0, 'should have total consumption')
  t.pass()
})

test('getConsumption - central DCS reads site power from the DCS worker', async (t) => {
  let capturedPayload
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }],
      featureConfig: { centralDCSSetup: { enabled: true, tag: 't-dcs-custom' } }
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [{ ts: 1700006400000, site_power_w: 5000000 }]
      }
    }
  })

  const result = await getConsumption(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000 }
  })

  t.is(capturedPayload.type, 'dcs-siemens', 'should tail the DCS worker type')
  t.is(capturedPayload.tag, 't-dcs-custom', 'should use the configured DCS tag')
  t.is(result.log[0].powerW, 5000000, 'should read site_power_w from the DCS log')
  t.pass()
})

test('getConsumption - non-DCS reads site power from the powermeter worker', async (t) => {
  let capturedPayload
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [{ ts: 1700006400000, site_power_w: 5000000 }]
      }
    }
  })

  await getConsumption(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000 }
  })

  t.is(capturedPayload.type, 'powermeter', 'should tail the powermeter worker type')
  t.is(capturedPayload.tag, 't-powermeter', 'should use the powermeter tag')
  t.pass()
})

test('getConsumption - byMeter reads by_meter_power_w and breaks down per meter', async (t) => {
  let capturedPayload
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }],
      featureConfig: { centralDCSSetup: { enabled: true, tag: 't-dcs-custom' } }
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [{ ts: 1700006400000, by_meter_power_w: { 'PM-1': 3000000, 'PM-2': 2000000 } }]
      }
    }
  })

  const result = await getConsumption(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, byMeter: true }
  })

  t.ok('by_meter_power_w' in capturedPayload.fields, 'should project the by_meter_power_w field')
  t.ok('by_meter_power_w' in capturedPayload.aggrFields, 'should aggregate the by_meter_power_w field')
  t.alike(result.log[0].powerW, { 'PM-1': 3000000, 'PM-2': 2000000 }, 'log carries per-meter power')
  // default interval for this range is 1h -> 1h bucket span
  t.alike(result.log[0].consumptionMWh, { 'PM-1': 3, 'PM-2': 2 }, 'per-meter consumption over the bucket span')
  t.alike(result.summary.groupedBy, {
    'PM-1': { avgPowerW: 3000000, totalConsumptionMWh: 3 },
    'PM-2': { avgPowerW: 2000000, totalConsumptionMWh: 2 }
  }, 'summary breaks down per meter')
  t.is(result.summary.avgPowerW, 5000000, 'site avg power sums the meters')
  t.is(result.summary.totalConsumptionMWh, 5, 'site total consumption sums the meters')
  t.pass()
})

test('getConsumption - byMeter throws when central DCS disabled', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async () => [] }
  })

  try {
    await getConsumption(mockCtx, {
      query: { start: 1700000000000, end: 1700100000000, byMeter: true }
    })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_BY_METER_REQUIRES_CENTRAL_DCS', 'should reject byMeter without central DCS')
  }
  t.pass()
})

test('getConsumption - byMeter empty results', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }],
      featureConfig: { centralDCSSetup: { enabled: true, tag: 't-dcs-custom' } }
    },
    net_r0: { jRequest: async () => ({}) }
  })

  const result = await getConsumption(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, byMeter: true }
  })

  t.is(result.log.length, 0, 'log should be empty with no data')
  t.is(result.summary.totalConsumptionMWh, 0, 'total should be zero')
  t.is(result.summary.avgPowerW, null, 'avg should be null')
  t.alike(result.summary.groupedBy, {}, 'no meters grouped')
  t.pass()
})

// Builds a Central-DCS ctx whose single ork returns the given by-meter rows.
const byMeterCtx = (rows) => withDataProxy({
  conf: {
    orks: [{ rpcPublicKey: 'key1' }],
    featureConfig: { centralDCSSetup: { enabled: true, tag: 't-dcs-custom' } }
  },
  net_r0: { jRequest: async () => rows }
})

// This range resolves to the default 1h interval, so each bucket spans 1 hour
// and per-meter MWh equals watts / 1e6.
const BY_METER_QUERY = { start: 1700000000000, end: 1700100000000, byMeter: true }

test('getConsumption - byMeter aggregates multiple buckets per meter', async (t) => {
  const mockCtx = byMeterCtx([
    { ts: 1700006400000, by_meter_power_w: { 'PM-1': 4000000, 'PM-2': 2000000 } },
    { ts: 1700010000000, by_meter_power_w: { 'PM-1': 2000000, 'PM-2': 2000000 } }
  ])

  const result = await getConsumption(mockCtx, { query: BY_METER_QUERY })

  t.is(result.log.length, 2, 'one log entry per ork row')
  t.alike(result.log[1].powerW, { 'PM-1': 2000000, 'PM-2': 2000000 }, 'second bucket carries its own power')
  t.is(result.summary.groupedBy['PM-1'].avgPowerW, 3000000, 'PM-1 avg power across both buckets')
  t.is(result.summary.groupedBy['PM-1'].totalConsumptionMWh, 6, 'PM-1 consumption sums both buckets')
  t.is(result.summary.avgPowerW, 5000000, 'site avg power is total meter power over bucket count')
  t.is(result.summary.totalConsumptionMWh, 10, 'site total sums every meter across buckets')
  t.pass()
})

test('getConsumption - byMeter handles a meter absent from some buckets', async (t) => {
  const mockCtx = byMeterCtx([
    { ts: 1700006400000, by_meter_power_w: { 'PM-1': 3000000, 'PM-2': 1000000 } },
    { ts: 1700010000000, by_meter_power_w: { 'PM-1': 1000000 } }
  ])

  const result = await getConsumption(mockCtx, { query: BY_METER_QUERY })

  t.alike(result.log[1].powerW, { 'PM-1': 1000000 }, 'absent meter is not fabricated on the bucket')
  t.is(result.summary.groupedBy['PM-1'].avgPowerW, 2000000, 'PM-1 averages over the 2 buckets it appears in')
  t.is(result.summary.groupedBy['PM-2'].avgPowerW, 1000000, 'PM-2 averages only over its single bucket')
  t.is(result.summary.groupedBy['PM-2'].totalConsumptionMWh, 1, 'PM-2 consumption counts only its bucket')
  t.pass()
})

test('getConsumption - byMeter tolerates a bucket with no by_meter_power_w', async (t) => {
  const mockCtx = byMeterCtx([
    { ts: 1700006400000, by_meter_power_w: { 'PM-1': 2000000 } },
    { ts: 1700010000000 }
  ])

  const result = await getConsumption(mockCtx, { query: BY_METER_QUERY })

  t.is(result.log.length, 2, 'the field-less row still yields a log entry')
  t.alike(result.log[1].powerW, {}, 'missing field becomes an empty per-meter map')
  t.alike(result.log[1].consumptionMWh, {}, 'and no per-meter consumption')
  // the empty bucket still counts toward the denominator, dragging the site average
  t.is(result.summary.avgPowerW, 1000000, 'site avg divides 2 MW across both buckets')
  t.is(result.summary.groupedBy['PM-1'].avgPowerW, 2000000, 'PM-1 averages only over the bucket it reported in')
  t.pass()
})

test('getConsumption - byMeter coerces null or non-object payloads to empty maps', async (t) => {
  const mockCtx = byMeterCtx([
    { ts: 1700006400000, by_meter_power_w: null },
    { ts: 1700010000000, by_meter_power_w: 5 }
  ])

  const result = await getConsumption(mockCtx, { query: BY_METER_QUERY })

  t.is(result.log.length, 2, 'both rows still produce log entries')
  t.alike(result.log[0].powerW, {}, 'null payload becomes an empty map')
  t.alike(result.log[1].powerW, {}, 'non-object payload becomes an empty map')
  t.alike(result.summary.groupedBy, {}, 'no meters are grouped')
  t.is(result.summary.totalConsumptionMWh, 0, 'no consumption accrues')
  t.is(result.summary.avgPowerW, 0, 'site avg is zero over the empty buckets')
  t.pass()
})

test('getConsumption - byMeter treats non-numeric meter power as zero consumption', async (t) => {
  const mockCtx = byMeterCtx([
    { ts: 1700006400000, by_meter_power_w: { 'PM-1': 'n/a', 'PM-2': 3000000 } }
  ])

  const result = await getConsumption(mockCtx, { query: BY_METER_QUERY })

  t.is(result.log[0].consumptionMWh['PM-1'], 0, 'unparseable power yields zero consumption')
  t.is(result.log[0].consumptionMWh['PM-2'], 3, 'the numeric meter still converts to MWh')
  t.is(result.summary.groupedBy['PM-1'].avgPowerW, 0, 'unparseable power averages to zero')
  t.pass()
})

test('getConsumption - byMeter yields an empty log when the ork errors', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }],
      featureConfig: { centralDCSSetup: { enabled: true, tag: 't-dcs-custom' } }
    },
    net_r0: { jRequest: async () => { throw new Error('ork down') } }
  })

  const result = await getConsumption(mockCtx, { query: BY_METER_QUERY })

  t.is(result.log.length, 0, 'a non-array ork result is treated as no data')
  t.is(result.summary.avgPowerW, null, 'avg is null with no data')
  t.alike(result.summary.groupedBy, {}, 'no meters grouped')
  t.pass()
})

test('getConsumption - aggregates multiple site-power buckets', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async () => [
        { ts: 1700006400000, site_power_w: 6000000 },
        { ts: 1700010000000, site_power_w: 4000000 }
      ]
    }
  })

  const result = await getConsumption(mockCtx, { query: { start: 1700000000000, end: 1700100000000 } })

  t.is(result.log.length, 2, 'one entry per bucket')
  t.is(result.log[0].consumptionMWh, 6, 'first bucket consumption over its 1h span')
  t.is(result.log[1].consumptionMWh, 4, 'second bucket consumption over its 1h span')
  t.is(result.summary.avgPowerW, 5000000, 'summary averages power across buckets')
  t.is(result.summary.totalConsumptionMWh, 10, 'summary sums consumption across buckets')
  t.pass()
})

test('getConsumption - treats a bucket with no site_power_w as zero', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async () => [
        { ts: 1700006400000, site_power_w: 5000000 },
        { ts: 1700010000000 }
      ]
    }
  })

  const result = await getConsumption(mockCtx, { query: { start: 1700000000000, end: 1700100000000 } })

  t.is(result.log[1].powerW, 0, 'missing site_power_w reads as zero power')
  t.is(result.log[1].consumptionMWh, 0, 'and zero consumption')
  t.is(result.summary.avgPowerW, 2500000, 'the zero bucket still counts toward the average')
  t.is(result.summary.totalConsumptionMWh, 5, 'total consumption sums only the reported bucket')
  t.pass()
})

test('getConsumption - byMeter honours an explicit 1h interval', async (t) => {
  let capturedPayload
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }],
      featureConfig: { centralDCSSetup: { enabled: true, tag: 't-dcs-custom' } }
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [
          { ts: 1700006400000, by_meter_power_w: { 'PM-1': 4000000 } },
          { ts: 1700010000000, by_meter_power_w: { 'PM-1': 2000000 } }
        ]
      }
    }
  })

  const result = await getConsumption(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, byMeter: true, interval: '1h' }
  })

  t.is(capturedPayload.key, 'stat-30m', 'hourly interval samples the finer 30m stat log')
  t.is(capturedPayload.groupRange, '1H', 'bucketed into 1h windows')
  t.is(result.log.length, 2, 'one log entry per bucket')
  t.alike(result.log[0].consumptionMWh, { 'PM-1': 4 }, '4 MW over a 1h bucket is 4 MWh')
  t.alike(result.log[1].consumptionMWh, { 'PM-1': 2 }, '2 MW over a 1h bucket is 2 MWh')
  t.is(result.summary.groupedBy['PM-1'].totalConsumptionMWh, 6, 'PM-1 consumption sums both hourly buckets')
  t.pass()
})

test('getConsumption - byMeter applies the 1d interval to the ork query and MWh scaling', async (t) => {
  let capturedPayload
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }],
      featureConfig: { centralDCSSetup: { enabled: true, tag: 't-dcs-custom' } }
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [
          { ts: 1700006400000, by_meter_power_w: { 'PM-1': 3000000, 'PM-2': 2000000 } },
          { ts: 1700092800000, by_meter_power_w: { 'PM-1': 1000000, 'PM-2': 2000000 } }
        ]
      }
    }
  })

  const result = await getConsumption(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, byMeter: true, interval: '1d' }
  })

  t.is(capturedPayload.key, 'stat-3h', 'daily interval tails the 3h stat log')
  t.is(capturedPayload.groupRange, '1D', 'and buckets into 1-day windows')
  t.is(result.log.length, 2, 'one log entry per daily bucket')
  t.alike(result.log[0].consumptionMWh, { 'PM-1': 72, 'PM-2': 48 }, 'first bucket per-meter MWh over the 24h span')
  t.alike(result.log[1].consumptionMWh, { 'PM-1': 24, 'PM-2': 48 }, 'second bucket per-meter MWh over the 24h span')
  t.is(result.summary.groupedBy['PM-1'].avgPowerW, 2000000, 'PM-1 avg power across both days')
  t.is(result.summary.groupedBy['PM-1'].totalConsumptionMWh, 96, 'PM-1 consumption sums both days')
  t.is(result.summary.totalConsumptionMWh, 192, 'site total over both days')
  t.is(result.summary.avgPowerW, 4000000, 'site avg power is total meter power over bucket count')
  t.pass()
})

test('getConsumption - byMeter applies the 1w interval to the ork query and MWh scaling', async (t) => {
  let capturedPayload
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }],
      featureConfig: { centralDCSSetup: { enabled: true, tag: 't-dcs-custom' } }
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [
          { ts: 1700006400000, by_meter_power_w: { 'PM-1': 1000000 } },
          { ts: 1700611200000, by_meter_power_w: { 'PM-1': 2000000 } }
        ]
      }
    }
  })

  const result = await getConsumption(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, byMeter: true, interval: '1w' }
  })

  t.is(capturedPayload.key, 'stat-3h', 'weekly interval tails the 3h stat log')
  t.is(capturedPayload.groupRange, '1W', 'and buckets into 1-week windows')
  t.is(result.log.length, 2, 'one log entry per weekly bucket')
  t.alike(result.log[0].consumptionMWh, { 'PM-1': 168 }, '1 MW over a 168h bucket is 168 MWh')
  t.alike(result.log[1].consumptionMWh, { 'PM-1': 336 }, '2 MW over a 168h bucket is 336 MWh')
  t.is(result.summary.groupedBy['PM-1'].totalConsumptionMWh, 504, 'PM-1 consumption sums both weekly buckets')
  t.pass()
})

test('getConsumption - site power applies the 1w interval to the ork query and MWh scaling', async (t) => {
  let capturedPayload
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [
          { ts: 1700006400000, site_power_w: 2000000 },
          { ts: 1700611200000, site_power_w: 1000000 }
        ]
      }
    }
  })

  const result = await getConsumption(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, interval: '1w' }
  })

  t.is(capturedPayload.key, 'stat-3h', 'weekly interval tails the 3h stat log')
  t.is(capturedPayload.groupRange, '1W', 'and buckets into 1-week windows')
  t.is(result.log.length, 2, 'one entry per weekly bucket')
  t.is(result.log[0].consumptionMWh, 336, '2 MW over a 168h bucket is 336 MWh')
  t.is(result.log[1].consumptionMWh, 168, '1 MW over a 168h bucket is 168 MWh')
  t.is(result.summary.avgPowerW, 1500000, 'summary averages power across both weekly buckets')
  t.is(result.summary.totalConsumptionMWh, 504, 'summary sums consumption across both buckets')
  t.pass()
})

// A requested interval makes the ork group raw samples into interval-aligned
// buckets, each returned with a "<start>-<end>" range-string ts. These consts
// model two consecutive grouped buckets returned from a single ork.
const DAY1_TS = '1770854400000-1770940799999'
const DAY1_START = 1770854400000
const DAY1_END = 1770940799999
const DAY2_TS = '1770940800000-1771027199999'
const DAY2_START = 1770940800000
const DAY2_END = 1771027199999

const WEEK1_TS = '1770854400000-1771459199999'
const WEEK1_START = 1770854400000
const WEEK1_END = 1771459199999
const WEEK2_TS = '1771459200000-1772063999999'
const WEEK2_START = 1771459200000
const WEEK2_END = 1772063999999

test('getConsumption - byMeter groups ork entries into interval-aligned buckets', async (t) => {
  let capturedPayload
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }],
      featureConfig: { centralDCSSetup: { enabled: true, tag: 't-dcs-custom' } }
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [
          { ts: DAY1_TS, by_meter_power_w: { 'PM-1': 3000000, 'PM-2': 2000000 } },
          { ts: DAY2_TS, by_meter_power_w: { 'PM-1': 1000000, 'PM-2': 2000000 } }
        ]
      }
    }
  })

  const result = await getConsumption(mockCtx, {
    query: { start: DAY1_START, end: DAY2_END, byMeter: true, interval: '1d' }
  })

  t.is(capturedPayload.groupRange, '1D', 'ork is asked to group into 1-day buckets')
  t.is(result.log.length, 2, 'one log entry per grouped bucket')
  t.is(result.log[0].ts, DAY1_START, 'bucket ts is normalized to its range start')
  t.is(typeof result.log[0].ts, 'number', 'ts is a number, not the range string')
  t.alike(result.log[0].timeRange, { startTs: DAY1_START, endTs: DAY1_END }, 'first bucket exposes its aggregation window')
  t.alike(result.log[1].timeRange, { startTs: DAY2_START, endTs: DAY2_END }, 'second bucket exposes its aggregation window')
  t.alike(result.log[0].consumptionMWh, { 'PM-1': 72, 'PM-2': 48 }, 'first bucket per-meter MWh over its 24h window')
  t.alike(result.log[1].consumptionMWh, { 'PM-1': 24, 'PM-2': 48 }, 'second bucket per-meter MWh over its 24h window')
  t.is(result.summary.groupedBy['PM-1'].totalConsumptionMWh, 96, 'PM-1 consumption sums both buckets')
  t.is(result.summary.totalConsumptionMWh, 192, 'site total sums both buckets')
  t.pass()
})

test('getConsumption - site power groups ork entries into interval-aligned buckets', async (t) => {
  let capturedPayload
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [
          { ts: WEEK1_TS, site_power_w: 2000000 },
          { ts: WEEK2_TS, site_power_w: 1000000 }
        ]
      }
    }
  })

  const result = await getConsumption(mockCtx, {
    query: { start: WEEK1_START, end: WEEK2_END, interval: '1w' }
  })

  t.is(capturedPayload.groupRange, '1W', 'ork is asked to group into 1-week buckets')
  t.is(result.log.length, 2, 'one entry per grouped bucket')
  t.is(result.log[0].ts, WEEK1_START, 'bucket ts is normalized to its range start')
  t.alike(result.log[0].timeRange, { startTs: WEEK1_START, endTs: WEEK1_END }, 'first bucket exposes its aggregation window')
  t.alike(result.log[1].timeRange, { startTs: WEEK2_START, endTs: WEEK2_END }, 'second bucket exposes its aggregation window')
  t.is(result.log[0].consumptionMWh, 336, '2 MW over a 168h bucket is 336 MWh')
  t.is(result.log[1].consumptionMWh, 168, '1 MW over a 168h bucket is 168 MWh')
  t.is(result.summary.totalConsumptionMWh, 504, 'total sums both weekly buckets')
  t.pass()
})

test('getConsumption - missing start throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getConsumption(mockCtx, { query: { end: 1700100000000 } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_START_END', 'should throw missing start/end error')
  }
  t.pass()
})

test('getConsumption - invalid range throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getConsumption(mockCtx, { query: { start: 1700100000000, end: 1700000000000 } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_INVALID_DATE_RANGE', 'should throw invalid range error')
  }
  t.pass()
})

test('getConsumption - empty ork results', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async () => ({}) }
  })

  const result = await getConsumption(mockCtx, { query: { start: 1700000000000, end: 1700100000000 } })
  t.ok(result.log, 'should return log array')
  t.is(result.log.length, 0, 'log should be empty with no data')
  t.is(result.summary.totalConsumptionMWh, 0, 'total should be zero')
  t.is(result.summary.avgPowerW, null, 'avg should be null')
  t.pass()
})

test('getConsumption - MWh scales with the bucket span', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async () => [{ ts: 1700006400000, site_power_w: 5000000 }]
    }
  })

  const query = { start: 1700000000000, end: 1700100000000 }
  const hourly = await getConsumption(mockCtx, { query: { ...query, interval: '1h' } })
  const daily = await getConsumption(mockCtx, { query: { ...query, interval: '1d' } })

  t.is(hourly.log[0].consumptionMWh, 5, '1h bucket at 5 MW is 5 MWh')
  t.is(daily.log[0].consumptionMWh, 120, '24h bucket at 5 MW is 120 MWh')
  t.is(hourly.log[0].powerW, daily.log[0].powerW, 'average power is unaffected by bucket span')
  t.pass()
})

test('calculateConsumptionSummary - calculates from log entries', (t) => {
  const log = [
    { ts: 1700006400000, powerW: 5000000, consumptionMWh: 120 },
    { ts: 1700092800000, powerW: 4000000, consumptionMWh: 96 }
  ]

  const summary = calculateConsumptionSummary(log)
  t.is(summary.totalConsumptionMWh, 216, 'should sum consumption')
  t.is(summary.avgPowerW, 4500000, 'should average power')
  t.pass()
})

test('calculateConsumptionSummary - handles empty log', (t) => {
  const summary = calculateConsumptionSummary([])
  t.is(summary.totalConsumptionMWh, 0, 'should be zero')
  t.is(summary.avgPowerW, null, 'should be null')
  t.pass()
})

test('calculateByMeterConsumptionSummary - averages power and sums consumption per meter', (t) => {
  const log = [
    { ts: 1, powerW: { 'PM-1': 4000000, 'PM-2': 2000000 }, consumptionMWh: { 'PM-1': 4, 'PM-2': 2 } },
    { ts: 2, powerW: { 'PM-1': 2000000, 'PM-2': 2000000 }, consumptionMWh: { 'PM-1': 2, 'PM-2': 2 } }
  ]

  const summary = calculateByMeterConsumptionSummary(log)
  t.is(summary.groupedBy['PM-1'].avgPowerW, 3000000, 'averages PM-1 power across buckets')
  t.is(summary.groupedBy['PM-1'].totalConsumptionMWh, 6, 'sums PM-1 consumption')
  t.is(summary.groupedBy['PM-2'].avgPowerW, 2000000, 'averages PM-2 power')
  t.is(summary.totalConsumptionMWh, 10, 'site total sums all meters')
  t.is(summary.avgPowerW, 5000000, 'site avg power is total meter power over bucket count')
  t.pass()
})

test('calculateByMeterConsumptionSummary - handles empty log', (t) => {
  const summary = calculateByMeterConsumptionSummary([])
  t.is(summary.totalConsumptionMWh, 0, 'should be zero')
  t.is(summary.avgPowerW, null, 'should be null')
  t.alike(summary.groupedBy, {}, 'no meters grouped')
  t.pass()
})

test('getConsumption - grouped by miner uses type group aggregation', async (t) => {
  let capturedPayload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [{
          ts: 1700006400000,
          power_w_type_group_sum_aggr: { 'S19-Pro': 3000000, S21: 2000000 }
        }]
      }
    }
  })

  const result = await getConsumption(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, groupBy: 'miner' }
  })

  t.is(capturedPayload.fields.power_w_type_group_sum, 1, 'should request type-group source field')
  t.is(capturedPayload.aggrFields.power_w_type_group_sum_aggr, 1, 'should request type-group aggregate field')
  t.is(result.log.length, 1, 'should map one grouped row')
  t.alike(result.log[0].powerW, { 'S19-Pro': 3000000, S21: 2000000 }, 'should map grouped power value')
  t.ok(result.log[0].consumptionMWh, 'should have consumptionMWh object')
  t.is(result.summary.totalConsumptionMWh, (5000000 * 24) / 1000000, 'should have site-wide total consumption')
  t.ok(result.summary.groupedBy, 'should have per-miner breakdown')
  t.is(result.summary.groupedBy['S19-Pro'].totalConsumptionMWh, (3000000 * 24) / 1000000, 'should have per-miner total')
  t.is(result.summary.groupedBy.S21.totalConsumptionMWh, (2000000 * 24) / 1000000, 'should have per-miner total')
  t.pass()
})

test('getConsumption - grouped by container uses container group aggregation', async (t) => {
  let capturedPayload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [{
          ts: 1700006400000,
          power_w_container_group_sum_aggr: { 'container-A': 4000000, 'container-B': 1000000 }
        }]
      }
    }
  })

  const result = await getConsumption(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, groupBy: 'container' }
  })

  t.is(capturedPayload.fields.power_w_container_group_sum, 1, 'should request container-group source field')
  t.is(capturedPayload.aggrFields.power_w_container_group_sum_aggr, 1, 'should request container-group aggregate field')
  t.is(result.log.length, 1, 'should map grouped row')
  t.alike(result.log[0].powerW, { 'container-A': 4000000, 'container-B': 1000000 }, 'should map container grouped power value')
  t.is(result.summary.totalConsumptionMWh, (5000000 * 24) / 1000000, 'should have site-wide total consumption')
  t.ok(result.summary.groupedBy, 'should have per-container breakdown')
  t.is(result.summary.groupedBy['container-A'].totalConsumptionMWh, (4000000 * 24) / 1000000, 'should have per-container total')
  t.is(result.summary.groupedBy['container-B'].totalConsumptionMWh, (1000000 * 24) / 1000000, 'should have per-container total')
  t.pass()
})

test('getConsumption - grouped by rack uses rack group aggregation', async (t) => {
  let capturedPayload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [{
          ts: 1700006400000,
          power_w_pdu_rack_group_sum_aggr: {
            'group-1_rack-1': 1000000, 'group-1_rack-2': 2000000, 'group-2_rack-1': 3000000
          }
        }]
      }
    }
  })

  const result = await getConsumption(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, groupBy: 'rack' }
  })

  t.is(capturedPayload.fields.power_w_pdu_rack_group_sum, 1, 'should request rack-group source field')
  t.is(capturedPayload.aggrFields.power_w_pdu_rack_group_sum_aggr, 1, 'should request rack-group aggregate field')
  t.is(result.log.length, 1, 'should map grouped row')
  t.alike(result.log[0].powerW, { 'group-1_rack-1': 1000000, 'group-1_rack-2': 2000000, 'group-2_rack-1': 3000000 }, 'should map all racks when no filter given')
  t.is(result.summary.totalConsumptionMWh, (6000000 * 24) / 1000000, 'should total all racks')
  t.ok(result.summary.groupedBy['group-1_rack-1'], 'should have per-rack breakdown')
  t.pass()
})

test('getConsumption - grouped by rack filters to requested racks', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async () => [{
        ts: 1700006400000,
        power_w_pdu_rack_group_sum_aggr: {
          'group-1_rack-1': 1000000, 'group-1_rack-2': 2000000, 'group-2_rack-1': 3000000
        }
      }]
    }
  })

  const result = await getConsumption(mockCtx, {
    query: {
      start: 1700000000000,
      end: 1700100000000,
      groupBy: 'rack',
      racks: 'group-1_rack-1, group-2_rack-1'
    }
  })

  t.alike(result.log[0].powerW, { 'group-1_rack-1': 1000000, 'group-2_rack-1': 3000000 }, 'should keep only requested racks')
  t.is(result.summary.totalConsumptionMWh, (4000000 * 24) / 1000000, 'summary should reflect filtered racks only')
  t.absent(result.summary.groupedBy['group-1_rack-2'], 'filtered-out rack should be absent from summary')
  t.pass()
})

test('getConsumption - grouped mode handles empty results', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async () => [] }
  })

  const result = await getConsumption(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, groupBy: 'miner' }
  })

  t.is(result.log.length, 0, 'grouped log should be empty when no data is returned')
  t.is(result.summary.avgPowerW, null, 'grouped empty summary should have null avg')
  t.is(result.summary.totalConsumptionMWh, 0, 'grouped empty summary should have zero total')
  t.pass()
})

test('calculateGroupedConsumptionSummary - calculates per-group and site-wide stats', (t) => {
  const log = [
    { ts: 1700006400000, powerW: { 'S19-Pro': 3000000, S21: 2000000 } },
    { ts: 1700092800000, powerW: { 'S19-Pro': 3500000, S21: 1500000 } }
  ]

  const summary = calculateGroupedConsumptionSummary(log, 'miner')
  t.is(summary.totalConsumptionMWh, (10000000 * 24) / 1000000, 'should have site-wide total')
  t.is(summary.avgPowerW, 5000000, 'should have site-wide average')
  t.ok(summary.groupedBy, 'should have per-group breakdown')
  t.is(summary.groupedBy['S19-Pro'].avgPowerW, 3250000, 'should average per-group power')
  t.is(summary.groupedBy['S19-Pro'].totalConsumptionMWh, (6500000 * 24) / 1000000, 'should sum per-group consumption')
  t.is(summary.groupedBy.S21.avgPowerW, 1750000, 'should average per-group power')
  t.pass()
})

test('calculateGroupedConsumptionSummary - handles empty log', (t) => {
  const summary = calculateGroupedConsumptionSummary([], 'miner')
  t.is(summary.avgPowerW, null, 'should be null')
  t.is(summary.totalConsumptionMWh, 0, 'should be zero')
  t.pass()
})

// ==================== Efficiency Tests ====================

test('getEfficiency - happy path', async (t) => {
  const dayTs = 1700006400000
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }]
    },
    net_r0: {
      jRequest: async () => {
        return [{ ts: dayTs, efficiency_w_ths_avg_aggr: 25.5 }]
      }
    }
  })

  const mockReq = {
    query: { start: 1700000000000, end: 1700100000000 }
  }

  const result = await getEfficiency(mockCtx, mockReq)
  t.ok(result.log, 'should return log array')
  t.ok(result.summary, 'should return summary')
  t.ok(Array.isArray(result.log), 'log should be array')
  t.ok(result.log.length > 0, 'log should have entries')
  t.is(result.log[0].efficiencyWThs, 25.5, 'should have efficiency value')
  t.ok(result.summary.avgEfficiencyWThs !== null, 'should have avg efficiency')
  t.pass()
})

test('getEfficiency - central DCS derives efficiency from DCS site power over miner hashrate', async (t) => {
  const dayTs = 1700006400000
  const payloads = []
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }],
      featureConfig: { centralDCSSetup: { enabled: true, tag: 't-dcs-custom' } }
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        payloads.push(payload)
        if (payload.type === 'dcs-siemens') {
          return [{ ts: dayTs, site_power_w: 3000000 }]
        }
        // miner hashrate: 1e11 Mh/s -> 1e5 THs
        return [{ ts: dayTs, hashrate_mhs_5m_sum_aggr: 100000000000 }]
      }
    }
  })

  const result = await getEfficiency(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000 }
  })

  const dcsPayload = payloads.find(p => p.type === 'dcs-siemens')
  const minerPayload = payloads.find(p => p.type === 'miner')
  t.ok(dcsPayload, 'should tail the DCS worker for site power')
  t.is(dcsPayload.tag, 't-dcs-custom', 'should use the configured DCS tag')
  t.is(dcsPayload.aggrFields.site_power_w, 1, 'should request site power aggregate')
  t.ok(minerPayload, 'should tail the miner worker for hashrate')
  t.is(minerPayload.aggrFields.hashrate_mhs_5m_sum_aggr, 1, 'should request hashrate aggregate')
  // 3,000,000 W / 100,000 THs = 30 W/THs
  t.is(result.log[0].efficiencyWThs, 30, 'should divide site power by hashrate')
  t.is(result.summary.avgEfficiencyWThs, 30, 'summary should reflect the derived efficiency')
  t.pass()
})

test('getEfficiency - central DCS with no hashrate yields zero, not a crash', async (t) => {
  const dayTs = 1700006400000
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }],
      featureConfig: { centralDCSSetup: { enabled: true } }
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (payload.type === 'dcs-siemens') return [{ ts: dayTs, site_power_w: 3000000 }]
        return []
      }
    }
  })

  const result = await getEfficiency(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000 }
  })

  t.is(result.log[0].efficiencyWThs, 0, 'should not divide by zero hashrate')
  t.pass()
})

test('getEfficiency - central DCS aligns multiple entries by timestamp', async (t) => {
  const ts1 = 1700006400000
  const ts2 = 1700092800000
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }],
      featureConfig: { centralDCSSetup: { enabled: true } }
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (payload.type === 'dcs-siemens') {
          return [
            { ts: ts1, site_power_w: 3000000 },
            { ts: ts2, site_power_w: 6000000 }
          ]
        }
        // 1e11 Mh/s -> 1e5 THs for both buckets
        return [
          { ts: ts1, hashrate_mhs_5m_sum_aggr: 100000000000 },
          { ts: ts2, hashrate_mhs_5m_sum_aggr: 100000000000 }
        ]
      }
    }
  })

  const result = await getEfficiency(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000 }
  })

  t.is(result.log.length, 2, 'should keep one entry per DCS bucket')
  // 3,000,000 / 100,000 = 30 ; 6,000,000 / 100,000 = 60
  t.is(result.log[0].efficiencyWThs, 30, 'first bucket pairs power with its own hashrate')
  t.is(result.log[1].efficiencyWThs, 60, 'second bucket pairs power with its own hashrate')
  t.is(result.summary.avgEfficiencyWThs, 45, 'summary averages across buckets')
  t.pass()
})

test('getEfficiency - central DCS handles non-overlapping timestamps in both series', async (t) => {
  const tsBoth = 1700006400000
  const tsDcsOnly = 1700092800000
  const tsMinerOnly = 1700179200000
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }],
      featureConfig: { centralDCSSetup: { enabled: true } }
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (payload.type === 'dcs-siemens') {
          return [
            { ts: tsBoth, site_power_w: 3000000 },
            { ts: tsDcsOnly, site_power_w: 9000000 }
          ]
        }
        return [
          { ts: tsBoth, hashrate_mhs_5m_sum_aggr: 100000000000 },
          { ts: tsMinerOnly, hashrate_mhs_5m_sum_aggr: 100000000000 }
        ]
      }
    }
  })

  const result = await getEfficiency(mockCtx, {
    query: { start: 1700000000000, end: 1700200000000 }
  })

  // Log is driven by DCS power points; a miner-only bucket has no power and is dropped.
  t.is(result.log.length, 2, 'should emit one entry per DCS bucket only')
  t.is(result.log[0].ts, tsBoth, 'first entry is the shared bucket')
  t.is(result.log[0].efficiencyWThs, 30, 'shared bucket divides power by hashrate')
  t.is(result.log[1].ts, tsDcsOnly, 'second entry is the DCS-only bucket')
  t.is(result.log[1].efficiencyWThs, 0, 'DCS-only bucket has no hashrate, yields zero')
  t.absent(result.log.find(e => e.ts === tsMinerOnly), 'miner-only bucket is not emitted')
  // (30 + 0) / 2 = 15
  t.is(result.summary.avgEfficiencyWThs, 15, 'summary averages over emitted buckets')
  t.pass()
})

test('getEfficiency - missing start throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getEfficiency(mockCtx, { query: { end: 1700100000000 } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_START_END', 'should throw missing start/end error')
  }
  t.pass()
})

test('getEfficiency - invalid range throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getEfficiency(mockCtx, { query: { start: 1700100000000, end: 1700000000000 } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_INVALID_DATE_RANGE', 'should throw invalid range error')
  }
  t.pass()
})

test('getEfficiency - empty ork results', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async () => ({}) }
  })

  const result = await getEfficiency(mockCtx, { query: { start: 1700000000000, end: 1700100000000 } })
  t.ok(result.log, 'should return log array')
  t.is(result.log.length, 0, 'log should be empty with no data')
  t.is(result.summary.avgEfficiencyWThs, null, 'avg should be null')
  t.pass()
})

test('calculateEfficiencySummary - calculates from log entries', (t) => {
  const log = [
    { ts: 1700006400000, efficiencyWThs: 25 },
    { ts: 1700092800000, efficiencyWThs: 27 }
  ]

  const summary = calculateEfficiencySummary(log)
  t.is(summary.avgEfficiencyWThs, 26, 'should average efficiency')
  t.pass()
})

test('calculateEfficiencySummary - handles empty log', (t) => {
  const summary = calculateEfficiencySummary([])
  t.is(summary.avgEfficiencyWThs, null, 'should be null')
  t.pass()
})

test('getEfficiency - grouped by miner uses type group aggregation', async (t) => {
  let capturedPayload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [{
          ts: 1700006400000,
          efficiency_w_ths_type_group_avg_aggr: { 'S19-Pro': 30, S21: 20 }
        }]
      }
    }
  })

  const result = await getEfficiency(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, groupBy: 'miner' }
  })

  t.is(capturedPayload.fields.efficiency_w_ths_type_group_avg, 1, 'should request type-group source field')
  t.is(capturedPayload.aggrFields.efficiency_w_ths_type_group_avg_aggr, 1, 'should request type-group aggregate field')
  t.is(result.log.length, 1, 'should map one grouped row')
  t.alike(result.log[0].efficiencyWThs, { 'S19-Pro': 30, S21: 20 }, 'should map grouped efficiency value')
  t.is(result.summary.avgEfficiencyWThs, 25, 'should average across all group readings')
  t.ok(result.summary.groupedBy, 'should have per-miner breakdown')
  t.is(result.summary.groupedBy['S19-Pro'].avgEfficiencyWThs, 30, 'should have per-miner avg')
  t.is(result.summary.groupedBy.S21.avgEfficiencyWThs, 20, 'should have per-miner avg')
  t.pass()
})

test('getEfficiency - grouped by container uses container group aggregation', async (t) => {
  let capturedPayload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [{
          ts: 1700006400000,
          efficiency_w_ths_container_group_avg_aggr: { 'container-A': 24, 'container-B': 28 }
        }]
      }
    }
  })

  const result = await getEfficiency(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, groupBy: 'container' }
  })

  t.is(capturedPayload.fields.efficiency_w_ths_container_group_avg, 1, 'should request container-group source field')
  t.is(capturedPayload.aggrFields.efficiency_w_ths_container_group_avg_aggr, 1, 'should request container-group aggregate field')
  t.is(result.log.length, 1, 'should map grouped row')
  t.alike(result.log[0].efficiencyWThs, { 'container-A': 24, 'container-B': 28 }, 'should map container grouped efficiency value')
  t.is(result.summary.avgEfficiencyWThs, 26, 'should average across all group readings')
  t.ok(result.summary.groupedBy, 'should have per-container breakdown')
  t.is(result.summary.groupedBy['container-A'].avgEfficiencyWThs, 24, 'should have per-container avg')
  t.is(result.summary.groupedBy['container-B'].avgEfficiencyWThs, 28, 'should have per-container avg')
  t.pass()
})

test('getEfficiency - grouped summary averages across multiple entries', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async () => [
        { ts: 1700006400000, efficiency_w_ths_container_group_avg_aggr: { 'container-A': 24, 'container-B': 28 } },
        { ts: 1700092800000, efficiency_w_ths_container_group_avg_aggr: { 'container-A': 26, 'container-B': 30 } }
      ]
    }
  })

  const result = await getEfficiency(mockCtx, {
    query: { start: 1700000000000, end: 1700200000000, groupBy: 'container' }
  })

  t.is(result.log.length, 2, 'should map both daily rows')
  t.is(result.summary.avgEfficiencyWThs, 27, 'site avg should span both entries ((24+28+26+30)/4)')
  t.is(result.summary.groupedBy['container-A'].avgEfficiencyWThs, 25, 'per-group avg should span both entries ((24+26)/2)')
  t.is(result.summary.groupedBy['container-B'].avgEfficiencyWThs, 29, 'per-group avg should span both entries ((28+30)/2)')
  t.pass()
})

test('getEfficiency - grouped by rack uses rack group aggregation', async (t) => {
  let capturedPayload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [{
          ts: 1700006400000,
          efficiency_w_ths_pdu_rack_group_avg_aggr: {
            'group-1_rack-1': 22, 'group-1_rack-2': 24, 'group-2_rack-1': 26
          }
        }]
      }
    }
  })

  const result = await getEfficiency(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, groupBy: 'rack' }
  })

  t.is(capturedPayload.fields.efficiency_w_ths_pdu_rack_group_avg, 1, 'should request rack-group source field')
  t.is(capturedPayload.aggrFields.efficiency_w_ths_pdu_rack_group_avg_aggr, 1, 'should request rack-group aggregate field')
  t.alike(result.log[0].efficiencyWThs, { 'group-1_rack-1': 22, 'group-1_rack-2': 24, 'group-2_rack-1': 26 }, 'should map all racks when no filter given')
  t.ok(result.summary.groupedBy['group-1_rack-1'], 'should have per-rack breakdown')
  t.pass()
})

test('getEfficiency - grouped by rack filters to requested racks', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async () => [{
        ts: 1700006400000,
        efficiency_w_ths_pdu_rack_group_avg_aggr: {
          'group-1_rack-1': 22, 'group-1_rack-2': 24, 'group-2_rack-1': 26
        }
      }]
    }
  })

  const result = await getEfficiency(mockCtx, {
    query: {
      start: 1700000000000,
      end: 1700100000000,
      groupBy: 'rack',
      racks: 'group-1_rack-1, group-2_rack-1'
    }
  })

  t.alike(result.log[0].efficiencyWThs, { 'group-1_rack-1': 22, 'group-2_rack-1': 26 }, 'should keep only requested racks')
  t.is(result.summary.avgEfficiencyWThs, 24, 'summary should reflect filtered racks only')
  t.absent(result.summary.groupedBy['group-1_rack-2'], 'filtered-out rack should be absent from summary')
  t.pass()
})

test('getEfficiency - grouped mode handles empty results', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async () => [] }
  })

  const result = await getEfficiency(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, groupBy: 'container' }
  })

  t.is(result.log.length, 0, 'grouped log should be empty when no data is returned')
  t.is(result.summary.avgEfficiencyWThs, null, 'grouped empty summary should have null avg')
  t.pass()
})

test('calculateGroupedEfficiencySummary - calculates per-group and site-wide stats', (t) => {
  const log = [
    { ts: 1700006400000, efficiencyWThs: { 'container-A': 24, 'container-B': 28 } },
    { ts: 1700092800000, efficiencyWThs: { 'container-A': 26, 'container-B': 30 } }
  ]

  const summary = calculateGroupedEfficiencySummary(log, 'container')
  t.is(summary.avgEfficiencyWThs, 27, 'should average across all group readings')
  t.ok(summary.groupedBy, 'should have per-group breakdown')
  t.is(summary.groupedBy['container-A'].avgEfficiencyWThs, 25, 'should average per-group efficiency')
  t.is(summary.groupedBy['container-B'].avgEfficiencyWThs, 29, 'should average per-group efficiency')
  t.pass()
})

test('calculateGroupedEfficiencySummary - skips zero readings and handles empty log', (t) => {
  const summary = calculateGroupedEfficiencySummary([
    { ts: 1700006400000, efficiencyWThs: { 'container-A': 24, 'container-B': 0 } }
  ], 'container')
  t.is(summary.groupedBy['container-A'].avgEfficiencyWThs, 24, 'should keep non-zero reading')
  t.absent(summary.groupedBy['container-B'], 'zero-only group should be excluded')

  const empty = calculateGroupedEfficiencySummary([], 'container')
  t.is(empty.avgEfficiencyWThs, null, 'should be null for empty log')
  t.pass()
})

// ==================== Miner Status Tests ====================

test('sumObjectValues - sums keyed object values', (t) => {
  t.is(sumObjectValues({ a: 5, b: 3, c: 2 }), 10, 'should sum all values')
  t.is(sumObjectValues({}), 0, 'should return 0 for empty object')
  t.is(sumObjectValues(null), 0, 'should return 0 for null')
  t.is(sumObjectValues(undefined), 0, 'should return 0 for undefined')
  t.is(sumObjectValues({ a: 'not_a_number', b: 5 }), 5, 'should skip non-numeric values')
  t.pass()
})

test('getMinerStatus - happy path', async (t) => {
  const dayTs = 1700006400000
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }]
    },
    net_r0: {
      jRequest: async () => {
        return [{
          ts: dayTs,
          type_cnt: { 'miner-am-s19xp': 60, 'miner-wm-m30sp': 40 },
          offline_cnt: { offl_hashboard: 5, offl_fan: 3 },
          power_mode_sleep_cnt: { sleep: 10 },
          maintenance_type_cnt: { repair: 2 }
        }]
      }
    }
  })

  const mockReq = {
    query: { start: 1700000000000, end: 1700100000000 }
  }

  const result = await getMinerStatus(mockCtx, mockReq)
  t.ok(result.log, 'should return log array')
  t.ok(result.summary, 'should return summary')
  t.ok(Array.isArray(result.log), 'log should be array')
  t.ok(result.log.length > 0, 'log should have entries')
  t.is(result.log[0].offline, 8, 'should sum offline counts (5+3)')
  t.is(result.log[0].sleep, 10, 'should sum sleep counts')
  t.is(result.log[0].maintenance, 2, 'should sum maintenance counts')
  t.is(result.log[0].online, 80, 'should derive online (100-8-10-2)')
  t.pass()
})

test('getMinerStatus - emits error and excludes it from online', async (t) => {
  let payload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, p) => {
        payload = p
        return [{
          ts: 1700006400000,
          type_cnt: { 'am-s19': 800, 'wm-m50': 481 },
          offline_cnt: {},
          power_mode_sleep_cnt: {},
          maintenance_type_cnt: {},
          error_cnt: { 'container-1a': 1 }
        }]
      }
    }
  })

  const result = await getMinerStatus(mockCtx, { query: { start: 1700000000000, end: 1700100000000 } })

  t.is(payload.aggrFields.error_cnt, 1, 'should request the error count field')
  t.is(result.log[0].error, 1, 'should surface the errored miner')
  t.is(result.log[0].online, 1280, 'online should exclude the errored miner (1281 - 1)')
  t.is(result.summary.avgError, 1, 'summary should carry avgError')
  t.pass()
})

test('getMinerStatus - groupBy=type returns per-type status counts', async (t) => {
  let payload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, p) => {
        payload = p
        return [{
          ts: 1700006400000,
          type_cnt: { 'am-s19': 800, 'wm-m50': 481 },
          offline_type_cnt: { 'wm-m50': 5 },
          power_mode_sleep_type_cnt: {},
          maintenance_type_cnt: { 'am-s19': 3 },
          error_type_cnt: { 'am-s19': 1 }
        }]
      }
    }
  })

  const result = await getMinerStatus(mockCtx, { query: { start: 1700000000000, end: 1700100000000, groupBy: 'type' } })

  t.is(payload.aggrFields.type_cnt, 1, 'should request per-type total')
  t.is(payload.aggrFields.offline_type_cnt, 1, 'should request per-type offline')
  t.is(payload.aggrFields.error_type_cnt, 1, 'should request per-type error')
  t.alike(result.log[0].total, { 'am-s19': 800, 'wm-m50': 481 }, 'should key total by type')
  t.is(result.log[0].online['am-s19'], 796, 'per-type online = 800 - 3 maintenance - 1 error')
  t.is(result.log[0].online['wm-m50'], 476, 'per-type online = 481 - 5 offline')
  t.is(result.log[0].error['am-s19'], 1, 'should key error by type')
  t.pass()
})

test('getMinerStatus - missing start throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getMinerStatus(mockCtx, { query: { end: 1700100000000 } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_START_END', 'should throw missing start/end error')
  }
  t.pass()
})

test('getMinerStatus - invalid range throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getMinerStatus(mockCtx, { query: { start: 1700100000000, end: 1700000000000 } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_INVALID_DATE_RANGE', 'should throw invalid range error')
  }
  t.pass()
})

test('getMinerStatus - empty ork results', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async () => ({}) }
  })

  const result = await getMinerStatus(mockCtx, { query: { start: 1700000000000, end: 1700100000000 } })
  t.ok(result.log, 'should return log array')
  t.is(result.log.length, 0, 'log should be empty with no data')
  t.is(result.summary.avgOnline, null, 'avg online should be null')
  t.is(result.summary.avgOffline, null, 'avg offline should be null')
  t.pass()
})

test('processMinerStatusData - processes daily entries', (t) => {
  const results = [[
    {
      ts: 1700006400000,
      type_cnt: { 'miner-am-s19xp': 60, 'miner-wm-m30sp': 40 },
      offline_cnt: { offl_hashboard: 5 },
      power_mode_sleep_cnt: { sleep: 10 },
      maintenance_type_cnt: { repair: 2 }
    }
  ]]

  const daily = processMinerStatusData(results)
  t.ok(typeof daily === 'object', 'should return object')
  const key = Object.keys(daily)[0]
  t.is(daily[key].offline, 5, 'should extract offline count')
  t.is(daily[key].sleep, 10, 'should extract sleep count')
  t.is(daily[key].maintenance, 2, 'should extract maintenance count')
  t.is(daily[key].online, 83, 'should derive online count (100-5-10-2)')
  t.pass()
})

test('processMinerStatusData - handles error results', (t) => {
  const results = [{ error: 'timeout' }]
  const daily = processMinerStatusData(results)
  t.ok(typeof daily === 'object', 'should return object')
  t.is(Object.keys(daily).length, 0, 'should be empty for error results')
  t.pass()
})

test('processMinerStatusData - aggregates multiple orks same day', (t) => {
  const results = [
    [{
      ts: 1700006400000,
      type_cnt: { 'miner-am-s19xp': 30, 'miner-wm-m30sp': 20 },
      offline_cnt: { offl_fan: 3 },
      power_mode_sleep_cnt: { sleep: 5 },
      maintenance_type_cnt: {}
    }],
    [{
      ts: 1700006400000,
      type_cnt: { 'miner-am-s19xp': 30, 'miner-wm-m30sp': 20 },
      offline_cnt: { offl_hashboard: 2 },
      power_mode_sleep_cnt: {},
      maintenance_type_cnt: { repair: 1 }
    }]
  ]

  const daily = processMinerStatusData(results)
  const key = Object.keys(daily)[0]
  t.is(daily[key].offline, 5, 'should sum offline across orks (3+2)')
  t.is(daily[key].sleep, 5, 'should sum sleep across orks')
  t.is(daily[key].maintenance, 1, 'should sum maintenance across orks')
  t.is(daily[key].online, 89, 'should derive total online (47+42)')
  t.pass()
})

test('processMinerStatusData - handles entries with aggrFields wrapper', (t) => {
  const results = [[
    {
      ts: 1700006400000,
      type_cnt: { 'miner-am-s19xp': 60, 'miner-wm-m30sp': 40 },
      aggrFields: {
        offline_cnt: { offl_hashboard: 10 },
        power_mode_sleep_cnt: { sleep: 5 },
        maintenance_type_cnt: { repair: 3 }
      }
    }
  ]]

  const daily = processMinerStatusData(results)
  const key = Object.keys(daily)[0]
  t.is(daily[key].offline, 10, 'should extract from aggrFields wrapper')
  t.is(daily[key].sleep, 5, 'should extract sleep from aggrFields')
  t.is(daily[key].maintenance, 3, 'should extract maintenance from aggrFields')
  t.pass()
})

test('calculateMinerStatusSummary - calculates from log entries', (t) => {
  const log = [
    { ts: 1700006400000, online: 80, offline: 10, sleep: 5, maintenance: 5 },
    { ts: 1700092800000, online: 85, offline: 8, sleep: 4, maintenance: 3 }
  ]

  const summary = calculateMinerStatusSummary(log)
  t.is(summary.avgOnline, 82.5, 'should average online')
  t.is(summary.avgOffline, 9, 'should average offline')
  t.is(summary.avgSleep, 4.5, 'should average sleep')
  t.is(summary.avgMaintenance, 4, 'should average maintenance')
  t.pass()
})

test('calculateMinerStatusSummary - handles empty log', (t) => {
  const summary = calculateMinerStatusSummary([])
  t.is(summary.avgOnline, null, 'should be null')
  t.is(summary.avgOffline, null, 'should be null')
  t.is(summary.avgSleep, null, 'should be null')
  t.is(summary.avgMaintenance, null, 'should be null')
  t.pass()
})

// ==================== Interval Utils Tests ====================

test('resolveInterval - auto-selects 1h for <= 2 days', (t) => {
  const twoDays = 2 * 24 * 60 * 60 * 1000
  t.is(resolveInterval(0, twoDays, null), '1h', 'should select 1h for 2 day range')
  t.is(resolveInterval(0, twoDays - 1, null), '1h', 'should select 1h for < 2 day range')
  t.pass()
})

test('resolveInterval - auto-selects 1d for <= 90 days', (t) => {
  const threeDays = 3 * 24 * 60 * 60 * 1000
  const ninetyDays = 90 * 24 * 60 * 60 * 1000
  t.is(resolveInterval(0, threeDays, null), '1d', 'should select 1d for 3 day range')
  t.is(resolveInterval(0, ninetyDays, null), '1d', 'should select 1d for 90 day range')
  t.pass()
})

test('resolveInterval - auto-selects 1w for > 90 days', (t) => {
  const ninetyOneDays = 91 * 24 * 60 * 60 * 1000
  t.is(resolveInterval(0, ninetyOneDays, null), '1w', 'should select 1w for > 90 day range')
  t.pass()
})

test('resolveInterval - uses requested interval when provided', (t) => {
  t.is(resolveInterval(0, 1000, '1w'), '1w', 'should use requested interval')
  t.is(resolveInterval(0, 999999999999, '1h'), '1h', 'should override auto with requested')
  t.pass()
})

test('getIntervalConfig - returns correct configs', (t) => {
  const h = getIntervalConfig('1h')
  t.is(h.key, 'stat-30m', '1h key should be stat-30m')
  t.is(h.groupRange, '1H', '1h groupRange should be 1H')

  const d = getIntervalConfig('1d')
  t.is(d.key, 'stat-3h', '1d key should be stat-3h')
  t.is(d.groupRange, '1D', '1d groupRange should be 1D')

  const w = getIntervalConfig('1w')
  t.is(w.key, 'stat-3h', '1w key should be stat-3h')
  t.is(w.groupRange, '1W', '1w groupRange should be 1W')

  t.pass()
})

// ==================== forEachRangeAggrItem Tests ====================

test('forEachRangeAggrItem - handles null entry without crashing', (t) => {
  let called = false
  forEachRangeAggrItem(null, () => { called = true })
  t.is(called, false, 'callback should not be called for null entry')
  forEachRangeAggrItem(undefined, () => { called = true })
  t.is(called, false, 'callback should not be called for undefined entry')
  t.pass()
})

// ==================== parseEntryTs Tests ====================

test('parseEntryTs - handles numeric ts', (t) => {
  t.is(parseEntryTs(1700006400000), 1700006400000, 'should return number as-is')
  t.pass()
})

test('parseEntryTs - handles range string ts', (t) => {
  t.is(parseEntryTs('1770854400000-1771459199999'), 1770854400000, 'should extract start of range')
  t.is(parseEntryTs('1771459200000-1771545599999'), 1771459200000, 'should extract start of range')
  t.pass()
})

test('parseEntryTs - handles plain numeric string', (t) => {
  t.is(parseEntryTs('1700006400000'), 1700006400000, 'should parse numeric string')
  t.pass()
})

test('parseEntryTs - returns null for invalid input', (t) => {
  t.is(parseEntryTs(null), null, 'null returns null')
  t.is(parseEntryTs(undefined), null, 'undefined returns null')
  t.pass()
})

// ==================== Miners By Container Tests ====================

test('getMinersByContainer - rolls up counts and metrics per container', async (t) => {
  let payload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, p) => {
        payload = p
        return [[{
          ts: 1769630399999,
          hashrate_mhs_5m_container_group_sum_aggr: { 'bitdeer-1a': 12000000, 'microbt-1': 8000000 },
          power_w_container_group_sum_aggr: { 'bitdeer-1a': 700000 },
          efficiency_w_ths_container_group_avg_aggr: { 'bitdeer-1a': 21.5 },
          temperature_c_group_max_aggr: { 'bitdeer-1a': 78 },
          temperature_c_group_avg_aggr: { 'bitdeer-1a': 61 },
          hashrate_mhs_5m_active_container_group_cnt: { 'bitdeer-1a': 198 },
          offline_cnt: { 'bitdeer-1a': 5 },
          error_cnt: { 'bitdeer-1a': 2 },
          not_mining_cnt: { 'microbt-1': 1 },
          power_mode_sleep_cnt: { 'bitdeer-1a': 1 },
          power_mode_low_cnt: {},
          power_mode_normal_cnt: { 'bitdeer-1a': 190, 'microbt-1': 149 },
          power_mode_high_cnt: { 'bitdeer-1a': 2 }
        }]]
      }
    }
  })

  const result = await getMinersByContainer(mockCtx, { query: {} })

  t.is(payload.keys[0].key, 'stat-rtd', 'should read the realtime snapshot')
  t.is(payload.limit, 1, 'should take the latest snapshot only')
  t.is(payload.aggrFields.offline_cnt, 1, 'should request container-keyed status counts')
  t.is(payload.aggrFields.hashrate_mhs_5m_active_container_group_cnt, 1, 'should request active count')

  const bd = result.containers['bitdeer-1a']
  t.is(bd.minerCount, 200, 'minerCount sums the mutually exclusive statuses (5+2+0+1+0+190+2)')
  t.is(bd.onlineCount, 198, 'onlineCount is the active (hashrate-producing) count')
  t.is(bd.offlineCount, 5, 'should carry offline count')
  t.is(bd.errorCount, 2, 'should carry error count')
  t.is(bd.sleepCount, 1, 'should carry sleep count')
  t.alike(bd.powerMode, { low: 0, normal: 190, high: 2 }, 'should break down power modes')
  t.is(bd.hashrateMhs, 12000000, 'should carry container hashrate')
  t.is(bd.powerW, 700000, 'should carry container power')
  t.is(bd.efficiencyWThs, 21.5, 'should carry container efficiency')
  t.alike(bd.temperatureC, { max: 78, avg: 61 }, 'should carry container temperature')

  const mb = result.containers['microbt-1']
  t.is(mb.minerCount, 150, 'container present in only some fields still totals (1 not-mining + 149 normal)')
  t.is(mb.offlineCount, 0, 'missing status defaults to zero')
  t.alike(mb.temperatureC, { max: null, avg: null }, 'missing temperature defaults to null')
  t.pass()
})

test('getMinersByContainer - merges across orks and handles empty results', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'a' }, { rpcPublicKey: 'b' }] },
    net_r0: {
      jRequest: async (key) => key === 'a'
        ? [[{ ts: 1, offline_cnt: { c1: 3 }, power_mode_normal_cnt: { c1: 10 } }]]
        : [[]]
    }
  })

  const result = await getMinersByContainer(mockCtx, { query: {} })
  t.is(result.containers.c1.offlineCount, 3, 'should read the contributing ork')
  t.is(result.containers.c1.minerCount, 13, 'should total across present fields')
  t.pass()
})

test('getMinersByContainer - no data returns empty container map', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'a' }] },
    net_r0: { jRequest: async () => [[]] }
  })
  const result = await getMinersByContainer(mockCtx, { query: {} })
  t.alike(result.containers, {}, 'should return an empty container map')
  t.pass()
})

// ==================== Inventory Summary Tests ====================

test('getInventorySummary - rolls up miner and spare-part counts by status/location', async (t) => {
  let payload = null
  // tailLogMulti returns, per ork, one result slot per key (miner, then the 3 spare-part types)
  const orkResult = [
    [{ miner_inventory_status_group_cnt_aggr: { ok_brand_new: 3, in_operation: 12, faulty: 1 }, miner_inventory_location_group_cnt_aggr: { 'site.warehouse': 13, 'miner.room': 2 } }],
    [{ spare_parts_cnt_aggr: 45, spare_part_inventory_status_group_cnt_aggr: { ok_brand_new: 31, spare: 10, faulty: 1, ok_repaired: 2, ok_recovered: 1 }, spare_part_inventory_location_group_cnt_aggr: { 'site.warehouse': 45 } }],
    [{ spare_parts_cnt_aggr: 50, spare_part_inventory_status_group_cnt_aggr: { ok_brand_new: 50 } }],
    [{ spare_parts_cnt_aggr: 61, spare_part_inventory_status_group_cnt_aggr: { ok_brand_new: 61 } }]
  ]
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async (key, method, p) => { payload = p; return orkResult } }
  })

  const result = await getInventorySummary(mockCtx, { query: {} })

  t.is(payload.keys.length, 4, 'should query the miner tag plus one per spare-part type')
  t.is(payload.keys[0].tag, 't-miner', 'first key is all miners')
  t.is(payload.keys[1].tag, 't-inventory-miner_part-controller', 'spare-part keys use the inventory tags')
  t.is(payload.aggrFields.miner_inventory_status_group_cnt_aggr, 1, 'should request miner status counts')

  t.alike(result.miners.byStatus, { ok_brand_new: 3, in_operation: 12, faulty: 1 }, 'passes miner status keys through untouched')
  t.alike(result.miners.byLocation, { 'site.warehouse': 13, 'miner.room': 2 }, 'passes miner location keys through untouched')
  t.is(result.spareParts.controller.total, 45, 'carries the spare-part total')
  t.is(result.spareParts.controller.byStatus.spare, 10, 'passes non-enum spare-part statuses through')
  t.is(result.spareParts.psu.total, 61, 'each spare-part type is keyed separately')
  t.pass()
})

test('getInventorySummary - sums keyed counts across orks', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'a' }, { rpcPublicKey: 'b' }] },
    net_r0: {
      jRequest: async (key) => key === 'a'
        ? [[{ miner_inventory_status_group_cnt_aggr: { faulty: 2 } }], [{ spare_parts_cnt_aggr: 5 }], [], []]
        : [[{ miner_inventory_status_group_cnt_aggr: { faulty: 3 } }], [{ spare_parts_cnt_aggr: 7 }], [], []]
    }
  })

  const result = await getInventorySummary(mockCtx, { query: {} })
  t.is(result.miners.byStatus.faulty, 5, 'should sum status counts across orks')
  t.is(result.spareParts.controller.total, 12, 'should sum spare-part totals across orks')
  t.pass()
})

test('getInventorySummary - empty results yield zeroed shape', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'a' }] },
    net_r0: { jRequest: async () => [[], [], [], []] }
  })
  const result = await getInventorySummary(mockCtx, { query: {} })
  t.alike(result.miners, { byStatus: {}, byLocation: {} }, 'miners default to empty maps')
  t.is(result.spareParts.hashboard.total, 0, 'spare-part totals default to zero')
  t.pass()
})

// ==================== Power Mode Tests ====================

test('processPowerModeData - handles range string ts with groupRange', (t) => {
  const results = [[{
    ts: '1700006400000-1700092799999',
    power_mode_group_aggr: { 'cont1-miner1': 'normal' },
    status_group_aggr: { 'cont1-miner1': 'mining' }
  }]]

  const points = processPowerModeData(results, '1D')
  t.ok(Object.keys(points).length > 0, 'should have entries despite range string ts')
  const key = Object.keys(points)[0]
  t.is(points[key].normal, 1, 'should count normal')
  t.pass()
})

test('processTemperatureData - handles range string ts with groupRange', (t) => {
  const results = [[{
    ts: '1700006400000-1700092799999',
    temperature_c_group_max_aggr: { cont1: 65 },
    temperature_c_group_avg_aggr: { cont1: 55 }
  }]]

  const points = processTemperatureData(results, '1D', null)
  t.ok(Object.keys(points).length > 0, 'should have entries despite range string ts')
  const key = Object.keys(points)[0]
  t.is(points[key].containers.cont1.maxC, 65, 'should have temp data')
  t.pass()
})

test('getPowerMode - happy path', async (t) => {
  const ts = 1700006400000
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }]
    },
    net_r0: {
      jRequest: async () => {
        return [{
          ts,
          power_mode_group_aggr: { 'cont1-miner1': 'normal', 'cont1-miner2': 'low' },
          status_group_aggr: { 'cont1-miner1': 'mining', 'cont1-miner2': 'mining' }
        }]
      }
    }
  })

  const result = await getPowerMode(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000 }
  })

  t.ok(result.log, 'should return log array')
  t.ok(result.summary, 'should return summary')
  t.ok(Array.isArray(result.log), 'log should be array')
  t.ok(result.log.length > 0, 'log should have entries')
  t.is(result.log[0].normal, 1, 'should count normal miners')
  t.is(result.log[0].low, 1, 'should count low miners')
  t.pass()
})

test('getPowerMode - missing start/end throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getPowerMode(mockCtx, { query: { end: 1700100000000 } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_START_END', 'should throw missing start/end error')
  }
  t.pass()
})

test('getPowerMode - invalid range throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getPowerMode(mockCtx, { query: { start: 1700100000000, end: 1700000000000 } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_INVALID_DATE_RANGE', 'should throw invalid range error')
  }
  t.pass()
})

test('getPowerMode - empty ork results', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async () => ({}) }
  })

  const result = await getPowerMode(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000 }
  })

  t.ok(result.log, 'should return log array')
  t.is(result.log.length, 0, 'log should be empty')
  t.is(result.summary.avgNormal, null, 'avg should be null')
  t.pass()
})

test('categorizeMiner - status overrides power mode', (t) => {
  t.is(categorizeMiner('normal', 'offline'), 'offline', 'offline status should override')
  t.is(categorizeMiner('high', 'error'), 'error', 'error status should override')
  t.is(categorizeMiner('normal', 'maintenance'), 'maintenance', 'maintenance should override')
  t.is(categorizeMiner('high', 'idle'), 'notMining', 'idle should map to notMining')
  t.is(categorizeMiner('high', 'stopped'), 'notMining', 'stopped should map to notMining')
  t.pass()
})

test('categorizeMiner - power mode categories', (t) => {
  t.is(categorizeMiner('low', 'mining'), 'low', 'low mode with mining status')
  t.is(categorizeMiner('high', 'mining'), 'high', 'high mode with mining status')
  t.is(categorizeMiner('sleep', 'mining'), 'sleep', 'sleep mode with mining status')
  t.is(categorizeMiner('normal', 'mining'), 'normal', 'normal mode with mining status')
  t.is(categorizeMiner('normal', ''), 'normal', 'normal mode with empty status')
  t.pass()
})

test('categorizeMiner - unknown power mode passes through raw value', (t) => {
  t.is(categorizeMiner('turbo', 'mining'), 'turbo', 'unknown mode should pass through')
  t.is(categorizeMiner('eco', ''), 'eco', 'unknown mode with empty status should pass through')
  t.pass()
})

test('categorizeMiner - null/undefined power mode defaults to normal', (t) => {
  t.is(categorizeMiner(null, 'mining'), 'normal', 'null mode should default to normal')
  t.is(categorizeMiner(undefined, 'mining'), 'normal', 'undefined mode should default to normal')
  t.is(categorizeMiner('', 'mining'), 'normal', 'empty string mode should default to normal')
  t.pass()
})

test('processPowerModeData - counts modes correctly', (t) => {
  const results = [[{
    ts: 1700006400000,
    power_mode_group_aggr: {
      'cont1-miner1': 'normal',
      'cont1-miner2': 'low',
      'cont1-miner3': 'high'
    },
    status_group_aggr: {
      'cont1-miner1': 'mining',
      'cont1-miner2': 'mining',
      'cont1-miner3': 'offline'
    }
  }]]

  const points = processPowerModeData(results, '1D')
  const key = Object.keys(points)[0]
  t.is(points[key].normal, 1, 'should count 1 normal')
  t.is(points[key].low, 1, 'should count 1 low')
  t.is(points[key].offline, 1, 'miner3 offline overrides high')
  t.is(points[key].high, 0, 'miner3 classified as offline, not high')
  t.pass()
})

test('processPowerModeData - handles error results', (t) => {
  const results = [{ error: 'timeout' }]
  const points = processPowerModeData(results, '1D')
  t.is(Object.keys(points).length, 0, 'should be empty')
  t.pass()
})

test('processPowerModeData - merges across multiple orks', (t) => {
  const results = [
    [{
      ts: 1700006400000,
      power_mode_group_aggr: { 'cont1-miner1': 'normal' },
      status_group_aggr: { 'cont1-miner1': 'mining' }
    }],
    [{
      ts: 1700006400000,
      power_mode_group_aggr: { 'cont2-miner1': 'low' },
      status_group_aggr: { 'cont2-miner1': 'mining' }
    }]
  ]

  const points = processPowerModeData(results, '1D')
  const key = Object.keys(points)[0]
  t.is(points[key].normal, 1, 'should count ork1 normal')
  t.is(points[key].low, 1, 'should count ork2 low')
  t.pass()
})

test('calculatePowerModeSummary - calculates averages', (t) => {
  const log = [
    { ts: 1, low: 2, normal: 8, high: 0, sleep: 0, offline: 0, notMining: 0, maintenance: 0, error: 0 },
    { ts: 2, low: 4, normal: 6, high: 0, sleep: 0, offline: 0, notMining: 0, maintenance: 0, error: 0 }
  ]

  const summary = calculatePowerModeSummary(log)
  t.is(summary.avgLow, 3, 'should average low')
  t.is(summary.avgNormal, 7, 'should average normal')
  t.pass()
})

test('calculatePowerModeSummary - handles empty log', (t) => {
  const summary = calculatePowerModeSummary([])
  t.is(summary.avgNormal, null, 'should be null')
  t.is(summary.avgLow, null, 'should be null')
  t.is(summary.avgOffline, null, 'should be null')
  t.pass()
})

// ==================== Power Mode Timeline Tests ====================

test('getPowerModeTimeline - happy path', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }]
    },
    net_r0: {
      jRequest: async () => {
        return [
          {
            ts: 1700000000000,
            power_mode_group_aggr: { 'cont1-miner1': 'normal' },
            status_group_aggr: { 'cont1-miner1': 'mining' }
          },
          {
            ts: 1700010800000,
            power_mode_group_aggr: { 'cont1-miner1': 'low' },
            status_group_aggr: { 'cont1-miner1': 'mining' }
          }
        ]
      }
    }
  })

  const result = await getPowerModeTimeline(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000 }
  })

  t.ok(result.log, 'should return log array')
  t.ok(Array.isArray(result.log), 'log should be array')
  t.ok(result.log.length > 0, 'log should have entries')
  t.is(result.log[0].minerId, 'cont1-miner1', 'should have miner ID')
  t.ok(result.log[0].segments.length > 0, 'should have segments')
  t.pass()
})

test('getPowerModeTimeline - default start/end', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async () => ([]) }
  })

  const result = await getPowerModeTimeline(mockCtx, { query: {} })
  t.ok(result.log, 'should return log with defaults')
  t.ok(Array.isArray(result.log), 'should be array')
  t.pass()
})

test('getPowerModeTimeline - invalid range throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getPowerModeTimeline(mockCtx, { query: { start: 1700100000000, end: 1700000000000 } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_INVALID_DATE_RANGE', 'should throw invalid range error')
  }
  t.pass()
})

test('getPowerModeTimeline - empty results', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async () => ({}) }
  })

  const result = await getPowerModeTimeline(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000 }
  })

  t.is(result.log.length, 0, 'should be empty')
  t.pass()
})

test('processPowerModeTimelineData - groups by miner and sorts by ts', (t) => {
  const results = [[
    {
      ts: 1700010800000,
      power_mode_group_aggr: { 'cont1-miner1': 'low' },
      status_group_aggr: { 'cont1-miner1': 'mining' }
    },
    {
      ts: 1700000000000,
      power_mode_group_aggr: { 'cont1-miner1': 'normal' },
      status_group_aggr: { 'cont1-miner1': 'mining' }
    }
  ]]

  const log = processPowerModeTimelineData(results, null)
  t.is(log.length, 1, 'should group into 1 miner')
  t.is(log[0].minerId, 'cont1-miner1', 'should have correct miner id')
  t.is(log[0].segments[0].powerMode, 'normal', 'first segment should be earlier entry (normal)')
  t.is(log[0].segments[1].powerMode, 'low', 'second segment should be later entry (low)')
  t.pass()
})

test('processPowerModeTimelineData - merges consecutive same-mode segments', (t) => {
  const results = [[
    {
      ts: 1700000000000,
      power_mode_group_aggr: { 'cont1-miner1': 'normal' },
      status_group_aggr: { 'cont1-miner1': 'mining' }
    },
    {
      ts: 1700010800000,
      power_mode_group_aggr: { 'cont1-miner1': 'normal' },
      status_group_aggr: { 'cont1-miner1': 'mining' }
    },
    {
      ts: 1700021600000,
      power_mode_group_aggr: { 'cont1-miner1': 'normal' },
      status_group_aggr: { 'cont1-miner1': 'mining' }
    }
  ]]

  const log = processPowerModeTimelineData(results, null)
  t.is(log[0].segments.length, 1, 'should merge 3 entries into 1 segment')
  t.is(log[0].segments[0].from, 1700000000000, 'segment should start at first entry')
  t.is(log[0].segments[0].to, 1700021600000, 'segment should end at last entry')
  t.pass()
})

test('processPowerModeTimelineData - mode changes create new segments', (t) => {
  const results = [[
    {
      ts: 1700000000000,
      power_mode_group_aggr: { 'cont1-miner1': 'normal' },
      status_group_aggr: { 'cont1-miner1': 'mining' }
    },
    {
      ts: 1700010800000,
      power_mode_group_aggr: { 'cont1-miner1': 'low' },
      status_group_aggr: { 'cont1-miner1': 'mining' }
    },
    {
      ts: 1700021600000,
      power_mode_group_aggr: { 'cont1-miner1': 'normal' },
      status_group_aggr: { 'cont1-miner1': 'mining' }
    }
  ]]

  const log = processPowerModeTimelineData(results, null)
  t.is(log[0].segments.length, 3, 'should create 3 separate segments')
  t.is(log[0].segments[0].powerMode, 'normal', 'first segment normal')
  t.is(log[0].segments[1].powerMode, 'low', 'second segment low')
  t.is(log[0].segments[2].powerMode, 'normal', 'third segment normal')
  t.pass()
})

test('processPowerModeTimelineData - extracts container from miner id', (t) => {
  const results = [[
    {
      ts: 1700000000000,
      power_mode_group_aggr: { 'container-a-pos1-miner1': 'normal' },
      status_group_aggr: { 'container-a-pos1-miner1': 'mining' }
    }
  ]]

  const log = processPowerModeTimelineData(results, null)
  t.is(log[0].container, 'container-a-pos1', 'should extract container from miner id')
  t.pass()
})

test('getPowerModeTimeline - always uses t-miner tag', async (t) => {
  let capturedPayload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return []
      }
    }
  })

  await getPowerModeTimeline(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, container: 'my-container' }
  })

  t.is(capturedPayload.tag, 't-miner', 'should always use t-miner tag for RPC')
  t.pass()
})

test('getPowerModeTimeline - returns all results without truncation', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }]
    },
    net_r0: {
      jRequest: async () => {
        const entries = []
        for (let i = 0; i < 5; i++) {
          entries.push({
            ts: 1700000000000 + i * 10800000,
            power_mode_group_aggr: { [`cont${i}-miner1`]: 'normal' },
            status_group_aggr: { [`cont${i}-miner1`]: 'mining' }
          })
        }
        return entries
      }
    }
  })

  const result = await getPowerModeTimeline(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000 }
  })

  t.is(result.log.length, 5, 'should return all results')
  t.pass()
})

test('processPowerModeTimelineData - filters by container post-RPC', (t) => {
  const results = [[
    {
      ts: 1700000000000,
      power_mode_group_aggr: { 'cont1-miner1': 'normal', 'cont2-miner1': 'low' },
      status_group_aggr: { 'cont1-miner1': 'mining', 'cont2-miner1': 'mining' }
    }
  ]]

  const log = processPowerModeTimelineData(results, 'cont1')
  t.is(log.length, 1, 'should only include miners from cont1')
  t.is(log[0].container, 'cont1', 'should be cont1')
  t.pass()
})

test('resolvePowerModeTimelineInterval - picks resolution by range', (t) => {
  const start = 1700000000000
  t.is(resolvePowerModeTimelineInterval(start, start + 7 * 24 * 60 * 60 * 1000), '1m', '7d range uses 1m')
  t.is(resolvePowerModeTimelineInterval(start, start + 30 * 24 * 60 * 60 * 1000), '30m', '30d range uses 30m')
  t.is(resolvePowerModeTimelineInterval(start, start + 60 * 24 * 60 * 60 * 1000), '3h', 'longer range uses 3h')
  t.is(resolvePowerModeTimelineInterval(start, start + 60 * 24 * 60 * 60 * 1000, '1m'), '1m', 'explicit interval wins')
  t.is(resolvePowerModeTimelineInterval(start, start + 1000, 'bogus'), '1m', 'unknown interval falls back to range')
  t.pass()
})

test('getPowerModeTimeline - fetches a 7d range as bounded 1m windows', async (t) => {
  const capturedPayloads = []
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayloads.push(payload)
        return []
      }
    }
  })

  const start = 1700000000000
  const end = start + 7 * 24 * 60 * 60 * 1000
  const result = await getPowerModeTimeline(mockCtx, { query: { start, end } })

  t.is(capturedPayloads.length, 14, 'should split 7d of 1m samples into 720-sample windows')
  t.is(capturedPayloads[0].key, 'stat-1m', 'should request the 1m stat log')
  t.is(capturedPayloads[0].start, start, 'first window should start at range start')
  t.is(capturedPayloads[13].end, end, 'last window should end at range end')
  t.is(capturedPayloads[0].limit, 721, 'window limit should cover the window samples')
  for (let i = 1; i < capturedPayloads.length; i++) {
    t.is(capturedPayloads[i].start, capturedPayloads[i - 1].end, `window ${i} should be contiguous`)
  }
  t.is(result.interval, '1m', 'should report the resolved interval')
  t.pass()
})

test('getPowerModeTimeline - folds segments across window boundaries', async (t) => {
  let call = 0
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        call++
        return [{
          ts: payload.start,
          power_mode_group_aggr: { 'cont1-miner1': call === 3 ? 'low' : 'normal' },
          status_group_aggr: { 'cont1-miner1': 'mining' }
        }]
      }
    }
  })

  const start = 1700000000000
  const end = start + 3 * 720 * 60 * 1000
  const result = await getPowerModeTimeline(mockCtx, { query: { start, end } })

  t.is(call, 3, 'should fetch three windows')
  t.is(result.log.length, 1, 'should keep one miner entry across windows')
  t.is(result.log[0].segments.length, 2, 'unchanged mode should merge across windows')
  t.is(result.log[0].segments[0].powerMode, 'normal', 'first segment spans first two windows')
  t.is(result.log[0].segments[1].powerMode, 'low', 'mode change opens a new segment')
  t.pass()
})

test('getPowerModeTimeline - explicit interval overrides range resolution', async (t) => {
  let capturedPayload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return []
      }
    }
  })

  const start = 1700000000000
  const end = start + 24 * 60 * 60 * 1000
  const result = await getPowerModeTimeline(mockCtx, { query: { start, end, interval: '3h' } })

  t.is(capturedPayload.key, 'stat-3h', 'should request the 3h stat log')
  t.is(result.interval, '3h', 'should report the requested interval')
  t.pass()
})

test('processPowerModeTimelineData - includes miners with status but no power mode', (t) => {
  const results = [[
    {
      ts: 1700000000000,
      power_mode_group_aggr: { 'cont1-miner1': 'normal' },
      status_group_aggr: { 'cont1-miner1': 'mining', 'cont1-miner2': 'offline' }
    },
    {
      ts: 1700000060000,
      power_mode_group_aggr: { 'cont1-miner1': 'normal', 'cont1-miner2': 'low' },
      status_group_aggr: { 'cont1-miner1': 'mining', 'cont1-miner2': 'mining' }
    }
  ]]

  const log = processPowerModeTimelineData(results, null)
  t.is(log.length, 2, 'should include both miners')

  const miner2 = log.find(e => e.minerId === 'cont1-miner2')
  t.is(miner2.segments.length, 2, 'status-only sample should form its own segment')
  t.is(miner2.segments[0].powerMode, 'offline', 'power mode should fall back to status')
  t.is(miner2.segments[1].powerMode, 'low', 'later sample should use the reported power mode')
  t.pass()
})

test('processPowerModeTimelineData - falls back to status when power mode is empty', (t) => {
  const results = [[
    {
      ts: 1700000000000,
      power_mode_group_aggr: { 'cont1-miner1': '' },
      status_group_aggr: { 'cont1-miner1': 'degraded' }
    }
  ]]

  const log = processPowerModeTimelineData(results, null)
  t.is(log[0].segments[0].powerMode, 'degraded', 'empty power mode should fall back to status')
  t.is(log[0].segments[0].status, 'degraded', 'status should be preserved')
  t.pass()
})

// ==================== Temperature Tests ====================

test('getTemperature - happy path', async (t) => {
  const ts = 1700006400000
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }]
    },
    net_r0: {
      jRequest: async () => {
        return [{
          ts,
          temperature_c_group_max_aggr: { container1: 65, container2: 72 },
          temperature_c_group_avg_aggr: { container1: 55, container2: 60 }
        }]
      }
    }
  })

  const result = await getTemperature(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000 }
  })

  t.ok(result.log, 'should return log array')
  t.ok(result.summary, 'should return summary')
  t.ok(Array.isArray(result.log), 'log should be array')
  t.ok(result.log.length > 0, 'log should have entries')
  t.ok(result.log[0].containers, 'should have containers object')
  t.is(result.log[0].containers.container1.maxC, 65, 'should have container1 max temp')
  t.is(result.log[0].containers.container2.avgC, 60, 'should have container2 avg temp')
  t.is(result.log[0].siteMaxC, 72, 'should have site max temp')
  t.ok(result.summary.peakTemp !== null, 'should have peak temp')
  t.pass()
})

test('getTemperature - missing start/end throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getTemperature(mockCtx, { query: { end: 1700100000000 } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_START_END', 'should throw missing start/end error')
  }
  t.pass()
})

test('getTemperature - invalid range throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getTemperature(mockCtx, { query: { start: 1700100000000, end: 1700000000000 } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_INVALID_DATE_RANGE', 'should throw invalid range error')
  }
  t.pass()
})

test('getTemperature - empty ork results', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async () => ({}) }
  })

  const result = await getTemperature(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000 }
  })

  t.ok(result.log, 'should return log array')
  t.is(result.log.length, 0, 'log should be empty')
  t.is(result.summary.avgMaxTemp, null, 'avg max should be null')
  t.is(result.summary.avgAvgTemp, null, 'avg avg should be null')
  t.is(result.summary.peakTemp, null, 'peak should be null')
  t.pass()
})

test('processTemperatureData - extracts per-container temps', (t) => {
  const results = [[{
    ts: 1700006400000,
    temperature_c_group_max_aggr: { cont1: 65, cont2: 72 },
    temperature_c_group_avg_aggr: { cont1: 55, cont2: 60 }
  }]]

  const points = processTemperatureData(results, '1D', null)
  const key = Object.keys(points)[0]
  t.is(points[key].containers.cont1.maxC, 65, 'should have cont1 max')
  t.is(points[key].containers.cont2.maxC, 72, 'should have cont2 max')
  t.is(points[key].containers.cont1.avgC, 55, 'should have cont1 avg')
  t.is(points[key].containers.cont2.avgC, 60, 'should have cont2 avg')
  t.pass()
})

test('processTemperatureData - calculates site-wide aggregates', (t) => {
  const results = [[{
    ts: 1700006400000,
    temperature_c_group_max_aggr: { cont1: 65, cont2: 72 },
    temperature_c_group_avg_aggr: { cont1: 55, cont2: 60 }
  }]]

  const points = processTemperatureData(results, '1D', null)
  const key = Object.keys(points)[0]
  t.is(points[key].siteMaxC, 72, 'site max should be highest container max')
  t.is(points[key].siteAvgC, 57.5, 'site avg should average container avgs')
  t.pass()
})

test('processTemperatureData - filters by container', (t) => {
  const results = [[{
    ts: 1700006400000,
    temperature_c_group_max_aggr: { cont1: 65, cont2: 72 },
    temperature_c_group_avg_aggr: { cont1: 55, cont2: 60 }
  }]]

  const points = processTemperatureData(results, '1D', 'cont1')
  const key = Object.keys(points)[0]
  t.ok(points[key].containers.cont1, 'should have cont1')
  t.ok(!points[key].containers.cont2, 'should not have cont2')
  t.is(points[key].siteMaxC, 65, 'site max should be cont1 max')
  t.pass()
})

test('processTemperatureData - handles error results', (t) => {
  const results = [{ error: 'timeout' }]
  const points = processTemperatureData(results, '1D', null)
  t.is(Object.keys(points).length, 0, 'should be empty')
  t.pass()
})

test('calculateTemperatureSummary - calculates averages and peak', (t) => {
  const log = [
    { ts: 1, containers: {}, siteMaxC: 70, siteAvgC: 55 },
    { ts: 2, containers: {}, siteMaxC: 75, siteAvgC: 60 }
  ]

  const summary = calculateTemperatureSummary(log)
  t.is(summary.avgMaxTemp, 72.5, 'should average max temps')
  t.is(summary.avgAvgTemp, 57.5, 'should average avg temps')
  t.is(summary.peakTemp, 75, 'should find peak temp')
  t.pass()
})

test('calculateTemperatureSummary - handles empty log', (t) => {
  const summary = calculateTemperatureSummary([])
  t.is(summary.avgMaxTemp, null, 'should be null')
  t.is(summary.avgAvgTemp, null, 'should be null')
  t.is(summary.peakTemp, null, 'should be null')
  t.pass()
})

test('getTemperature - always uses t-miner tag with container post-filter', async (t) => {
  let capturedPayload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return []
      }
    }
  })

  await getTemperature(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, container: 'my-container' }
  })

  t.is(capturedPayload.tag, 't-miner', 'should always use t-miner tag for RPC')
  t.pass()
})

// ==================== Container Telemetry Tests ====================

test('getContainerTelemetry - happy path', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }]
    },
    net_r0: {
      jRequest: async (key, method, payload) => {
        if (method === 'listThings') {
          return [{ id: 'miner-1', tags: ['container-bitdeer-9a'] }]
        }
        if (method === 'tailLog') {
          return [{
            ts: 1700006400000,
            container_specific_stats_group_aggr: {
              'bitdeer-9a': { hot_temp_c_w_1_group: 35, tank1_bar_group: 1.2 }
            }
          }]
        }
        return {}
      }
    }
  })

  const mockReq = {
    params: { id: 'bitdeer-9a' },
    query: {}
  }

  const result = await getContainerTelemetry(mockCtx, mockReq)
  t.is(result.id, 'bitdeer-9a', 'should return container id')
  t.ok(Array.isArray(result.miners), 'should return miners array')
  t.is(result.miners.length, 1, 'should have one miner')
  t.ok(result.telemetry, 'should return telemetry data')
  t.is(result.telemetry.hot_temp_c_w_1_group, 35, 'should have sensor values')
  t.pass()
})

test('getContainerTelemetry - missing id throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getContainerTelemetry(mockCtx, { params: {}, query: {} })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_CONTAINER_ID', 'should throw missing id error')
  }
  t.pass()
})

test('getContainerTelemetry - no sensor data returns null telemetry', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async () => [] }
  })

  const result = await getContainerTelemetry(mockCtx, {
    params: { id: 'bitdeer-9a' },
    query: {}
  })
  t.is(result.telemetry, null, 'telemetry should be null when no data')
  t.ok(Array.isArray(result.miners), 'miners should be array')
  t.is(result.miners.length, 0, 'miners array should be empty')
  t.pass()
})

test('processContainerMiners - extracts miners from results', (t) => {
  const results = [
    [{ id: 'miner-1', tags: ['container-bitdeer-9a'] }],
    [{ id: 'miner-2', tags: ['container-bitdeer-9a'] }]
  ]
  const miners = processContainerMiners(results)
  t.is(miners.length, 2, 'should extract miners from all orks')
  t.pass()
})

test('processContainerMiners - handles error results', (t) => {
  const results = [{ error: 'timeout' }]
  const miners = processContainerMiners(results)
  t.is(miners.length, 0, 'should return empty array for errors')
  t.pass()
})

test('processContainerSensorSnapshot - extracts matching container', (t) => {
  const results = [[{
    ts: 1700006400000,
    container_specific_stats_group_aggr: {
      'bitdeer-9a': { hot_temp_c_w_1_group: 35 },
      'antspace-2b': { supply_liquid_temp_group: 40 }
    }
  }]]
  const telemetry = processContainerSensorSnapshot(results, 'bitdeer-9a')
  t.ok(telemetry, 'should find matching container')
  t.is(telemetry.hot_temp_c_w_1_group, 35, 'should return correct container data')
  t.pass()
})

test('processContainerSensorSnapshot - returns null when no match', (t) => {
  const results = [[{
    ts: 1700006400000,
    container_specific_stats_group_aggr: {
      'antspace-2b': { supply_liquid_temp_group: 40 }
    }
  }]]
  const telemetry = processContainerSensorSnapshot(results, 'bitdeer-9a')
  t.is(telemetry, null, 'should return null when no matching container')
  t.pass()
})

test('processContainerSensorSnapshot - prefix match fallback', (t) => {
  const results = [[{
    ts: 1700006400000,
    container_specific_stats_group_aggr: {
      'bitdeer-9a-combo': { hot_temp_c_w_1_group: 35 }
    }
  }]]
  const telemetry = processContainerSensorSnapshot(results, 'bitdeer-9a')
  t.ok(telemetry, 'should find via prefix match')
  t.is(telemetry.hot_temp_c_w_1_group, 35, 'should return correct data')
  t.pass()
})

// ==================== Container History Tests ====================

test('getContainerHistory - happy path', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }]
    },
    net_r0: {
      jRequest: async () => {
        return [{
          ts: 1700006400000,
          container_specific_stats_group_aggr: {
            'bitdeer-9a': { hot_temp_c_w_1_group: 35, tank1_bar_group: 1.2 }
          }
        }, {
          ts: 1700006700000,
          container_specific_stats_group_aggr: {
            'bitdeer-9a': { hot_temp_c_w_1_group: 36, tank1_bar_group: 1.3 }
          }
        }]
      }
    }
  })

  const mockReq = {
    params: { id: 'bitdeer-9a' },
    query: { start: 1700000000000, end: 1700100000000 }
  }

  const result = await getContainerHistory(mockCtx, mockReq)
  t.ok(result.log, 'should return log array')
  t.ok(Array.isArray(result.log), 'log should be array')
  t.is(result.log.length, 2, 'should have 2 entries')
  t.is(result.log[0].hot_temp_c_w_1_group, 35, 'should have sensor values')
  t.ok(result.log[0].ts < result.log[1].ts, 'should be sorted by ts')
  t.pass()
})

test('getContainerHistory - interval selects the stat key', async (t) => {
  const keys = []
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        keys.push(payload.key)
        return []
      }
    }
  })

  const query = { start: 1700000000000, end: 1700100000000 }
  for (const interval of ['20s', '1m', '5m', '30m', '3h', '1d']) {
    await getContainerHistory(mockCtx, { params: { id: 'bitdeer-9a' }, query: { ...query, interval } })
  }

  t.alike(keys, ['stat-20s', 'stat-1m', 'stat-5m', 'stat-30m', 'stat-3h', 'stat-1D'], 'should map each interval to its stat key')
  t.pass()
})

test('getContainerHistory - defaults to stat-5m without interval', async (t) => {
  let capturedKey = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedKey = payload.key
        return []
      }
    }
  })

  await getContainerHistory(mockCtx, {
    params: { id: 'bitdeer-9a' },
    query: { start: 1700000000000, end: 1700100000000 }
  })

  t.is(capturedKey, 'stat-5m', 'should keep the existing default')
  t.pass()
})

test('getContainerHistory - missing id throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getContainerHistory(mockCtx, { params: {}, query: {} })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_CONTAINER_ID', 'should throw missing id error')
  }
  t.pass()
})

test('getContainerHistory - invalid range throws', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [] },
    net_r0: { jRequest: async () => ({}) }
  })

  try {
    await getContainerHistory(mockCtx, {
      params: { id: 'bitdeer-9a' },
      query: { start: 1700100000000, end: 1700000000000 }
    })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_INVALID_DATE_RANGE', 'should throw invalid range error')
  }
  t.pass()
})

test('getContainerHistory - uses defaults when no start/end', async (t) => {
  let capturedPayload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return []
      }
    }
  })

  const result = await getContainerHistory(mockCtx, {
    params: { id: 'bitdeer-9a' },
    query: {}
  })
  t.ok(capturedPayload.start > 0, 'should have default start')
  t.ok(capturedPayload.end > capturedPayload.start, 'end should be after start')
  t.is(capturedPayload.limit, 10080, 'should use default limit')
  t.ok(result.log, 'should return log array')
  t.is(result.log.length, 0, 'log should be empty with no data')
  t.pass()
})

test('getContainerHistory - empty results', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async () => [] }
  })

  const result = await getContainerHistory(mockCtx, {
    params: { id: 'bitdeer-9a' },
    query: { start: 1700000000000, end: 1700100000000 }
  })
  t.ok(result.log, 'should return log array')
  t.is(result.log.length, 0, 'log should be empty')
  t.pass()
})

test('processContainerHistoryData - filters by container id', (t) => {
  const results = [[
    {
      ts: 1700006400000,
      container_specific_stats_group_aggr: {
        'bitdeer-9a': { hot_temp_c_w_1_group: 35 },
        'antspace-2b': { supply_liquid_temp_group: 40 }
      }
    }
  ]]
  const log = processContainerHistoryData(results, 'bitdeer-9a')
  t.is(log.length, 1, 'should have one entry')
  t.is(log[0].hot_temp_c_w_1_group, 35, 'should have correct container data')
  t.ok(!log[0].supply_liquid_temp_group, 'should not include other container data')
  t.pass()
})

test('processContainerHistoryData - handles error results', (t) => {
  const results = [{ error: 'timeout' }]
  const log = processContainerHistoryData(results, 'bitdeer-9a')
  t.is(log.length, 0, 'should be empty for error results')
  t.pass()
})

test('processContainerHistoryData - sorts by timestamp', (t) => {
  const results = [[
    {
      ts: 1700006700000,
      container_specific_stats_group_aggr: {
        'bitdeer-9a': { hot_temp_c_w_1_group: 36 }
      }
    },
    {
      ts: 1700006400000,
      container_specific_stats_group_aggr: {
        'bitdeer-9a': { hot_temp_c_w_1_group: 35 }
      }
    }
  ]]
  const log = processContainerHistoryData(results, 'bitdeer-9a')
  t.ok(log[0].ts < log[1].ts, 'entries should be sorted ascending')
  t.pass()
})

test('processTemperatureData - rolling avg for same container across entries', (t) => {
  const results = [[
    {
      ts: 1700006400000,
      temperature_c_group_max_aggr: { cont1: 65 },
      temperature_c_group_avg_aggr: { cont1: 55 }
    },
    {
      ts: 1700006400000,
      temperature_c_group_max_aggr: { cont1: 70 },
      temperature_c_group_avg_aggr: { cont1: 60 }
    }
  ]]

  const points = processTemperatureData(results, '1D', null)
  const key = Object.keys(points)[0]
  t.is(points[key].containers.cont1.maxC, 70, 'should take max of both entries')
  t.ok(points[key].containers.cont1.avgC > 55, 'should compute rolling avg')
  t.pass()
})

test('processContainerHistoryData - prefix match fallback', (t) => {
  const results = [[
    {
      ts: 1700006400000,
      container_specific_stats_group_aggr: {
        'bitdeer-9a-sensor1': { humidity: 45 }
      }
    }
  ]]
  const log = processContainerHistoryData(results, 'bitdeer-9a')
  t.is(log.length, 1, 'should match via prefix')
  t.is(log[0].humidity, 45, 'should return prefixed container data')
  t.pass()
})

test('processContainerHistoryData - no match skips entry', (t) => {
  const results = [[
    {
      ts: 1700006400000,
      container_specific_stats_group_aggr: {
        'other-container': { humidity: 45 }
      }
    }
  ]]
  const log = processContainerHistoryData(results, 'bitdeer-9a')
  t.is(log.length, 0, 'should skip non-matching entries')
  t.pass()
})

test('processContainerSensorSnapshot - handles non-object aggrData', (t) => {
  const results = [[
    {
      container_specific_stats_group_aggr: 'invalid'
    }
  ]]
  const result = processContainerSensorSnapshot(results, 'cont1')
  t.is(result, null, 'should return null for non-object aggrData')
  t.pass()
})

test('processTemperatureData - handles non-object maxObj', (t) => {
  const results = [[{
    ts: 1700006400000,
    temperature_c_group_max_aggr: 'invalid',
    temperature_c_group_avg_aggr: {}
  }]]

  const points = processTemperatureData(results, '1D', null)
  const key = Object.keys(points)[0]
  t.is(points[key].siteMaxC, null, 'should not process non-object maxObj')
  t.pass()
})

test('processPowerModeData - handles non-object powerModeObj', (t) => {
  const results = [[{
    ts: 1700006400000,
    power_mode_group_aggr: 'invalid',
    status_group_aggr: {}
  }]]

  const points = processPowerModeData(results, '1D')
  const key = Object.keys(points)[0]
  t.is(points[key].normal, 0, 'should not process non-object powerModeObj')
  t.pass()
})

test('getPowerMode - sets groupRange for multi-day range', async (t) => {
  let capturedPayload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, params) => {
        capturedPayload = params
        return []
      }
    }
  })

  const threeDaysMs = 3 * 24 * 60 * 60 * 1000
  await getPowerMode(mockCtx, {
    query: { start: 1700000000000, end: 1700000000000 + threeDaysMs }
  })

  t.is(capturedPayload.groupRange, '1D', 'should set groupRange for multi-day range')
  t.pass()
})

test('getTemperature - sets groupRange for multi-day range', async (t) => {
  let capturedPayload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, params) => {
        capturedPayload = params
        return []
      }
    }
  })

  const threeDaysMs = 3 * 24 * 60 * 60 * 1000
  await getTemperature(mockCtx, {
    query: { start: 1700000000000, end: 1700000000000 + threeDaysMs }
  })

  t.is(capturedPayload.groupRange, '1D', 'should set groupRange for multi-day range')
  t.pass()
})

test('processPowerModeTimelineData - handles non-object powerModeObj', (t) => {
  const results = [[{
    ts: 1700006400000,
    power_mode_group_aggr: 'invalid',
    status_group_aggr: {}
  }]]

  const log = processPowerModeTimelineData(results, null)
  t.is(log.length, 0, 'should skip non-object powerModeObj entries')
  t.pass()
})

// ==================== Grouped range-string ts Tests ====================
// With groupRange the ork returns ts as a range string ("<start>-<end>"). Passing that
// through raw reaches the UI as a non-numeric timestamp, which charts plotted at the epoch
// (a 1970-01-01 point) and, once they started rejecting undated readings, dropped entirely.
// Any range over two days resolves to interval '1d', so this is the default report view.

const RANGE_TS = '1770854400000-1771459199999'
const RANGE_START = 1770854400000

test('getHashrate - normalizes a grouped range-string ts to its start', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async () => [{ ts: RANGE_TS, hashrate_mhs_5m_sum_aggr: 100000 }]
    }
  })

  // 7-day span -> interval '1d' -> groupRange '1D'
  const result = await getHashrate(mockCtx, {
    query: { start: 1770854400000, end: 1771459199999 }
  })

  t.is(result.log[0].ts, RANGE_START, 'ts should be the numeric range start')
  t.is(typeof result.log[0].ts, 'number', 'ts should be a number, not a range string')
  t.is(result.log[0].hashrateMhs, 100000, 'value should be preserved')
})

test('getConsumption - normalizes a grouped range-string ts to its start', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async () => [{ ts: RANGE_TS, power_w_sum_aggr: 5000 }]
    }
  })

  const result = await getConsumption(mockCtx, {
    query: { start: 1770854400000, end: 1771459199999 }
  })

  t.is(result.log[0].ts, RANGE_START, 'ts should be the numeric range start')
  t.is(typeof result.log[0].ts, 'number', 'ts should be a number, not a range string')
})

test('getEfficiency - normalizes a grouped range-string ts to its start', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async () => [{ ts: RANGE_TS, efficiency_w_ths_aggr: 24 }]
    }
  })

  const result = await getEfficiency(mockCtx, {
    query: { start: 1770854400000, end: 1771459199999 }
  })

  t.is(result.log[0].ts, RANGE_START, 'ts should be the numeric range start')
  t.is(typeof result.log[0].ts, 'number', 'ts should be a number, not a range string')
})

// ==================== timeRange attribute Tests ====================
// When the ork aggregates over a range interval (groupRange), each entry covers a
// window, not an instant. ts stays the numeric range start; timeRange carries the
// full window so consumers no longer have to re-parse the raw range string.

const RANGE_END = 1771459199999

test('parseEntryTimeRange - parses a range string into startTs/endTs', (t) => {
  t.alike(parseEntryTimeRange(RANGE_TS), { startTs: RANGE_START, endTs: RANGE_END })
  t.is(parseEntryTimeRange(1770854400000), null, 'numeric ts has no range')
  t.is(parseEntryTimeRange('1770854400000'), null, 'plain numeric string has no range')
  t.is(parseEntryTimeRange('abc-def'), null, 'non-numeric parts are rejected')
  t.is(parseEntryTimeRange(null), null, 'null ts has no range')
})

test('getHashrate - exposes the aggregation window as timeRange', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async () => [{ ts: RANGE_TS, hashrate_mhs_5m_sum_aggr: 100000 }]
    }
  })

  const result = await getHashrate(mockCtx, {
    query: { start: 1770854400000, end: 1771459199999 }
  })

  t.alike(result.log[0].timeRange, { startTs: RANGE_START, endTs: RANGE_END }, 'timeRange should cover the full window')
  t.is(result.log[0].ts, RANGE_START, 'ts should stay the numeric range start')
})

test('getHashrate - omits timeRange for non-grouped numeric entries', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async () => [{ ts: 1700006400000, hashrate_mhs_5m_sum_aggr: 100000 }]
    }
  })

  const result = await getHashrate(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000 }
  })

  t.is('timeRange' in result.log[0], false, 'point entries should not carry timeRange')
})

test('getConsumption - exposes the aggregation window as timeRange', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async () => [{ ts: RANGE_TS, site_power_w: 5000 }]
    }
  })

  const result = await getConsumption(mockCtx, {
    query: { start: 1770854400000, end: 1771459199999 }
  })

  t.alike(result.log[0].timeRange, { startTs: RANGE_START, endTs: RANGE_END }, 'timeRange should cover the full window')
  t.is(result.log[0].powerW, 5000, 'value should be preserved')
})

test('getEfficiency - exposes the aggregation window as timeRange', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async () => [{ ts: RANGE_TS, efficiency_w_ths_aggr: 24 }]
    }
  })

  const result = await getEfficiency(mockCtx, {
    query: { start: 1770854400000, end: 1771459199999 }
  })

  t.alike(result.log[0].timeRange, { startTs: RANGE_START, endTs: RANGE_END }, 'timeRange should cover the full window')
})

test('getEfficiency - central DCS path normalizes range ts and exposes timeRange', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }],
      featureConfig: { centralDCSSetup: { enabled: true, tag: 't-dcs' } }
    },
    net_r0: {
      jRequest: async (key, method, params) => {
        if (params.type === 'dcs-siemens') return [{ ts: RANGE_TS, site_power_w: 5000 }]
        return [{ ts: RANGE_TS, hashrate_mhs_5m_sum_aggr: 100000000 }]
      }
    }
  })

  const result = await getEfficiency(mockCtx, {
    query: { start: 1770854400000, end: 1771459199999 }
  })

  t.is(result.log[0].ts, RANGE_START, 'ts should be the numeric range start')
  t.is(typeof result.log[0].ts, 'number', 'ts should be a number, not a range string')
  t.alike(result.log[0].timeRange, { startTs: RANGE_START, endTs: RANGE_END }, 'timeRange should cover the full window')
  t.is(result.log[0].efficiencyWThs, 50, 'efficiency should join power and hashrate on the same bucket')
})

test('getMinerStatus - exposes the aggregation window as timeRange', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async () => [{ ts: RANGE_TS, type_cnt: { m50: 10 }, offline_cnt: { m50: 2 } }]
    }
  })

  const result = await getMinerStatus(mockCtx, {
    query: { start: 1770854400000, end: 1771459199999 }
  })

  t.alike(result.log[0].timeRange, { startTs: RANGE_START, endTs: RANGE_END }, 'timeRange should cover the full window')
  t.is(result.log[0].online, 8, 'counts should be preserved')
})

test('processGroupedMinerStatusData - exposes the aggregation window as timeRange', (t) => {
  const daily = processGroupedMinerStatusData([[{ ts: RANGE_TS, type_cnt: { m50: 10 }, offline_type_cnt: { m50: 2 } }]])

  const bucket = daily[RANGE_START]
  t.alike(bucket.timeRange, { startTs: RANGE_START, endTs: RANGE_END }, 'timeRange should cover the full window')
})

test('getPowerMode - exposes the aggregation window as timeRange on grouped buckets', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async () => [{
        ts: RANGE_TS,
        power_mode_group_aggr: { 'container-1-m1': 'normal' },
        status_group_aggr: {}
      }]
    }
  })

  const result = await getPowerMode(mockCtx, {
    query: { start: 1770854400000, end: 1771459199999 }
  })

  t.alike(result.log[0].timeRange, { startTs: RANGE_START, endTs: RANGE_END }, 'timeRange should cover the full window')
  t.is(result.log[0].normal, 1, 'categories should be preserved')
})

test('getTemperature - exposes the aggregation window as timeRange on grouped buckets', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async () => [{
        ts: RANGE_TS,
        temperature_c_group_max_aggr: { c1: 80 },
        temperature_c_group_avg_aggr: { c1: 60 }
      }]
    }
  })

  const result = await getTemperature(mockCtx, {
    query: { start: 1770854400000, end: 1771459199999 }
  })

  t.alike(result.log[0].timeRange, { startTs: RANGE_START, endTs: RANGE_END }, 'timeRange should cover the full window')
  t.is(result.log[0].siteMaxC, 80, 'values should be preserved')
})

// --- nominal hashrate (opt-in) -------------------------------------------------

test('getHashrate - without nominal the payload and response are unchanged', async (t) => {
  let capturedPayload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [{ ts: 1700006400000, hashrate_mhs_5m_sum_aggr: 100000, nominal_hashrate_mhs_sum_aggr: 200000 }]
      }
    }
  })

  const result = await getHashrate(mockCtx, { query: { start: 1700000000000, end: 1700100000000 } })

  t.absent('nominal_hashrate_mhs_sum' in capturedPayload.fields, 'should not project the nominal field')
  t.absent('nominal_hashrate_mhs_sum_aggr' in capturedPayload.aggrFields, 'should not aggregate the nominal field')
  t.alike(result.log[0], { ts: 1700006400000, hashrateMhs: 100000 }, 'log entry shape is untouched')
  t.alike(result.summary, { avgHashrateMhs: 100000 }, 'summary shape is untouched')
  t.pass()
})

test('getHashrate - nominal adds per-bucket nominal and pct', async (t) => {
  let capturedPayload = null
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (key, method, payload) => {
        capturedPayload = payload
        return [
          { ts: 1700006400000, hashrate_mhs_5m_sum_aggr: 75310000000, nominal_hashrate_mhs_sum_aggr: 78275000000 },
          { ts: 1700010000000, hashrate_mhs_5m_sum_aggr: 55730000000, nominal_hashrate_mhs_sum_aggr: 78275000000 }
        ]
      }
    }
  })

  const result = await getHashrate(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, nominal: true }
  })

  t.ok('nominal_hashrate_mhs_sum' in capturedPayload.fields, 'should project the nominal field')
  t.ok('nominal_hashrate_mhs_sum_aggr' in capturedPayload.aggrFields, 'should aggregate the nominal field')
  t.is(result.log[0].nominalHashrateMhs, 78275000000, 'carries per-bucket nominal')
  // 75.31 PH/s against a 78.275 PH/s nominal is the 96.2 % in the design
  t.is(Math.round(result.log[0].pctOfNominal * 10) / 10, 96.2, 'first bucket pct matches the design')
  t.is(Math.round(result.log[1].pctOfNominal * 10) / 10, 71.2, 'second bucket pct matches the design')
  t.is(result.summary.nominalHashrateMhs, 78275000000, 'summary carries nominal')
  t.is(Math.round(result.summary.avgPctOfNominal * 10) / 10, 83.7, 'summary averages the pct')
  t.pass()
})

test('getHashrate - nominal accepts the string form and tolerates a zero nominal', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async () => [
        { ts: 1700006400000, hashrate_mhs_5m_sum_aggr: 100000 },
        { ts: 1700010000000, hashrate_mhs_5m_sum_aggr: 100000, nominal_hashrate_mhs_sum_aggr: 0 }
      ]
    }
  })

  const result = await getHashrate(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, nominal: 'true' }
  })

  t.is(result.log[0].nominalHashrateMhs, 0, 'a missing nominal reads as 0')
  t.is(result.log[0].pctOfNominal, null, 'and yields no percentage rather than Infinity')
  t.is(result.log[1].pctOfNominal, null, 'an explicit zero nominal also yields null')
  t.is(result.summary.avgPctOfNominal, null, 'summary pct is null when nothing is installed')
  t.pass()
})

test('getHashrate - nominal on an empty log', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async () => [] }
  })

  const result = await getHashrate(mockCtx, {
    query: { start: 1700000000000, end: 1700100000000, nominal: true }
  })

  t.is(result.log.length, 0, 'no entries')
  t.alike(result.summary, {
    avgHashrateMhs: null,
    nominalHashrateMhs: null,
    avgPctOfNominal: null
  }, 'summary carries the nominal keys as null')
  t.pass()
})

test('calculateHashrateSummary - stays backwards compatible without the flag', (t) => {
  const log = [
    { ts: 1, hashrateMhs: 100, nominalHashrateMhs: 200 },
    { ts: 2, hashrateMhs: 300, nominalHashrateMhs: 200 }
  ]

  t.alike(calculateHashrateSummary(log), { avgHashrateMhs: 200 }, 'no nominal keys are emitted')
  t.alike(calculateHashrateSummary([]), { avgHashrateMhs: null }, 'empty log unchanged')
  t.pass()
})

// ==================== Miners By Type Tests ====================

test('getMinersByType - rolls up per-type counts, power and modes', async (t) => {
  let payload = null
  const orkResult = [
    [{
      type_cnt: { 'miner-am-s19xp': 100, 'miner-wm-m53s': 50 },
      power_w_type_group_sum_aggr: { 'miner-am-s19xp': 300000, 'miner-wm-m53s': 170000 },
      offline_type_cnt: { 'miner-am-s19xp': 5 },
      error_type_cnt: { 'miner-wm-m53s': 2 },
      maintenance_type_cnt: { 'miner-am-s19xp': 1 },
      power_mode_sleep_type_cnt: { 'miner-am-s19xp': 4 },
      power_mode_low_type_cnt: { 'miner-wm-m53s': 8 },
      power_mode_normal_type_cnt: { 'miner-am-s19xp': 90, 'miner-wm-m53s': 40 },
      power_mode_high_type_cnt: {}
    }]
  ]
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async (key, method, p) => { payload = p; return orkResult } }
  })

  const result = await getMinersByType(mockCtx, { query: {} })
  t.is(payload.keys.length, 1, 'should query one tail-log key')
  t.is(payload.keys[0].key, 'stat-5m', 'should read the 5m snapshot')
  t.ok(payload.aggrFields.type_cnt, 'should restrict the row to aggr fields')

  const s19 = result.types['miner-am-s19xp']
  t.is(s19.count, 100)
  t.is(s19.powerW, 300000)
  t.is(s19.offline, 5)
  t.is(s19.maintenance, 1)
  t.alike(s19.powerModes, { sleep: 4, low: 0, normal: 90, high: 0 })

  const m53 = result.types['miner-wm-m53s']
  t.is(m53.error, 2)
  t.alike(m53.powerModes, { sleep: 0, low: 8, normal: 40, high: 0 })
  t.pass()
})

test('getMinersByType - sums counts across orks', (t) => {
  const result = processMinersByType([
    [[{ type_cnt: { 'miner-am-s21': 10 }, power_w_type_group_sum_aggr: { 'miner-am-s21': 1000 } }]],
    [[{ type_cnt: { 'miner-am-s21': 5 }, power_w_type_group_sum_aggr: { 'miner-am-s21': 700 } }]]
  ])
  t.is(result.types['miner-am-s21'].count, 15, 'should sum type counts')
  t.is(result.types['miner-am-s21'].powerW, 1700, 'should sum power')
  t.pass()
})

test('getMinersByType - empty results', (t) => {
  t.alike(processMinersByType([]), { types: {} })
  t.pass()
})

// ==================== Inventory Miner Distribution Tests ====================

test('computeInstalledCapacity - parses container miner tags and subtracts connected miners', (t) => {
  const containers = [
    {
      tags: ['t-container', 'container_miner-mbt-kehua_wm-m53s'],
      info: { container: 'c1', nominalMinerCapacity: 100 }
    },
    {
      tags: ['container_miner-as-immersion_am-s19xp'],
      info: { container: 'c2', nominalMinerCapacity: 200 }
    },
    { tags: ['t-container'], info: { container: 'c3', nominalMinerCapacity: 50 } }
  ]
  const byContainer = {
    c1: { minerCount: 90 },
    c2: { minerCount: 250 }
  }

  const capacity = computeInstalledCapacity(containers, byContainer)
  t.alike(capacity['miner-wm-m53s'], { total: 100, available: 10 }, 'available = capacity - connected')
  t.alike(capacity['miner-am-s19xp'], { total: 200, available: 0 }, 'over-filled containers clamp to 0')
  t.is(Object.keys(capacity).length, 2, 'containers without a miner tag are skipped')
  t.pass()
})

test('getInventoryMinerDistribution - builds per-type rows with locations and capacity', async (t) => {
  const calls = []
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }], site: 'site-a' },
    net_r0: {
      jRequest: async (key, method, payload) => {
        calls.push({ method, payload })
        if (method === 'listThings' && payload.query.$and) {
          return [
            { id: 'm1', type: 'miner-am-s19xp' },
            { id: 'm2', type: 'miner-am-s19xp' },
            { id: 'm3', type: 'miner-wm-m53s' }
          ]
        }
        if (method === 'listThings') {
          return [{
            id: 'c1',
            tags: ['container_miner-as-immersion_am-s19xp'],
            info: { container: 'c1', nominalMinerCapacity: 3 }
          }]
        }
        if (method === 'tailLogMulti' && payload.aggrFields.miner_inventory_location_group_cnt_aggr) {
          return [
            [{ miner_inventory_location_group_cnt_aggr: { 'miner.room': 1, 'site.warehouse': 0 } }],
            [{ miner_inventory_location_group_cnt_aggr: { 'site.warehouse': 1 } }]
          ]
        }
        if (method === 'tailLogMulti') return [[{}]]
        return []
      }
    }
  })

  const result = await getInventoryMinerDistribution(mockCtx, { query: {} })
  t.is(result.totalMiners, 3, 'should count all site miners')

  const minerListCall = calls.find(c => c.method === 'listThings' && c.payload.query.$and)
  t.alike(
    minerListCall.payload.query.$and[0],
    { 'info.site': { $eq: 'site-a' } },
    'should scope miners to the configured site'
  )

  const locationCall = calls.find(c => c.method === 'tailLogMulti' && c.payload.aggrFields.miner_inventory_location_group_cnt_aggr)
  t.alike(
    locationCall.payload.keys.map(k => k.tag),
    ['t-miner-am-s19xp', 't-miner-wm-m53s'],
    'should query one tail-log key per discovered type'
  )

  const s19Row = result.rows.find(r => r.type === 'miner-am-s19xp')
  t.is(s19Row.count, 2)
  t.is(s19Row.locations['miner.room'], 1, 'should report aggregated locations')
  t.is(s19Row.locations.unknown, 1, 'unknown = count minus located miners')
  t.is(s19Row.totalPositions, 3, 'capacity from container miner tag')

  const m53Row = result.rows.find(r => r.type === 'miner-wm-m53s')
  t.is(m53Row.locations.unknown, 0, 'located miners leave no unknowns')
  t.is(m53Row.totalPositions, null, 'types without containers have no capacity')
  t.pass()
})

test('getInventoryMinerDistribution - empty fleet', async (t) => {
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: { jRequest: async () => [] }
  })

  const result = await getInventoryMinerDistribution(mockCtx, { query: {} })
  t.alike(result, { rows: [], totalMiners: 0 })
  t.pass()
})
