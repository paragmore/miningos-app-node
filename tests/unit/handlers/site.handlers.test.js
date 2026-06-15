'use strict'

const test = require('brittle')
const { getSiteLiveStatus, getSiteOverviewGroupsStats, getSiteEfficiency } = require('../../../workers/lib/server/handlers/site.handlers')
const { withDataProxy } = require('../helpers/mockHelpers')

function createMockCtx (tailLogMultiResponse, extDataResponse, globalConfigResponse, listThingsResponse = [], featureConfig = {}) {
  return withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }],
      featureConfig
    },
    net_r0: {
      jRequest: async (key, method) => {
        if (method === 'tailLogMulti') return tailLogMultiResponse
        if (method === 'getWrkExtData') return extDataResponse
        if (method === 'getGlobalConfig') return globalConfigResponse
        if (method === 'listThings') return listThingsResponse
        return {}
      }
    }
  })
}

test('getSiteLiveStatus - returns composed response with correct structure', async (t) => {
  const tailLogMultiResponse = [
    // Key 0: miner stats
    [{ hashrate_mhs_1m_sum_aggr: 601432498437, nominal_hashrate_mhs_sum_aggr: 741423000000, online_or_minor_error_miners_amount_aggr: 1850, not_mining_miners_amount_aggr: 23, offline_or_sleeping_miners_amount_aggr: 45, hashrate_mhs_1m_cnt_aggr: 1930, alerts_aggr: { critical: 8, high: 12, medium: 39 } }],
    // Key 1: powermeter stats
    [{}],
    // Key 2: container stats
    [{ container_nominal_miner_capacity_sum_aggr: 2000 }]
  ]

  // Real minerpool ext-data shape: entries with a stats ARRAY (one item per pool), hashrate in H/s
  const extDataResponse = [
    { ts: '1769686500000', stats: [{ poolType: 'f2pool', hashrate: 279670375560265, active_workers_count: 1823, worker_count: 1930 }] }
  ]

  const globalConfigResponse = {
    nominalHashrate: 741423000000,
    nominalPowerAvailability_MW: 22.5
  }

  // Site power meter thing snapshot (consumption source, like the header UI)
  const listThingsResponse = [
    { id: 'pm-site', tags: ['t-powermeter'], last: { snap: { stats: { power_w: 16701560 } }, alerts: [] } }
  ]

  const ctx = createMockCtx(tailLogMultiResponse, extDataResponse, globalConfigResponse, listThingsResponse)
  const req = { query: {} }

  const result = await getSiteLiveStatus(ctx, req)

  t.ok(result.hashrate, 'should have hashrate')
  t.is(result.hashrate.value, 601432498437, 'hashrate value should match')
  t.is(result.hashrate.nominal, 741423000000, 'hashrate nominal should match')
  t.ok(result.hashrate.utilization > 0, 'hashrate utilization should be > 0')
  t.is(result.hashrate.unit, 'MH/s', 'hashrate unit should be MH/s')

  t.ok(result.power, 'should have power')
  t.is(result.power.value, 16701560, 'power value should come from site meter snapshot')
  t.is(result.power.nominal, 22500000, 'power nominal should be MW * 1000000')
  t.is(result.power.unit, 'W', 'power unit should be W')
  t.is(result.power.alert, '', 'power alert should be empty without device alerts')
  t.is(result.power.error, false, 'power error should be false without device alerts')

  t.ok(result.efficiency, 'should have efficiency')
  // 16701560 W / 601432.498437 TH/s, unrounded like the header UI
  t.is(result.efficiency.value, 16701560 / (601432498437 / 1000000), 'efficiency should be consumption over THs, unrounded')
  t.is(result.efficiency.unit, 'W/TH/s', 'efficiency unit should be W/TH/s')

  t.ok(result.miners, 'should have miners')
  t.is(result.miners.online, 1850, 'miners online should match')
  t.is(result.miners.error, 23, 'miners error should match')
  t.is(result.miners.offline, 45, 'miners offline should match')
  t.is(result.miners.total, 1930, 'miners total should match')
  t.is(result.miners.containerCapacity, 2000, 'container capacity should match')

  t.ok(result.alerts, 'should have alerts')
  t.is(result.alerts.critical, 8, 'critical alerts should match')
  t.is(result.alerts.high, 12, 'high alerts should match')
  t.is(result.alerts.medium, 39, 'medium alerts should match')
  t.is(result.alerts.total, 59, 'total alerts should be sum')

  t.ok(result.pools, 'should have pools')
  t.is(result.pools.totalHashrate.value, 279670375560265 / 1000000, 'pool hashrate should be converted H/s to MH/s')
  t.is(result.pools.totalHashrate.unit, 'MH/s', 'pool hashrate unit should be MH/s')
  t.is(result.pools.activeWorkers, 1823, 'active workers should match')
  t.is(result.pools.totalWorkers, 1930, 'total workers should match')

  t.ok(result.ts, 'should have timestamp')
  t.pass()
})

test('getSiteLiveStatus - handles empty ork responses', async (t) => {
  const ctx = createMockCtx([], [], {})
  const req = { query: {} }

  const result = await getSiteLiveStatus(ctx, req)

  t.is(result.hashrate.value, 0, 'hashrate should be 0')
  t.is(result.power.value, 0, 'power should be 0')
  t.is(result.efficiency.value, 0, 'efficiency should be 0')
  t.is(result.miners.total, 0, 'miners total should be 0')
  t.is(result.alerts.total, 0, 'alerts total should be 0')
  t.is(result.pools.totalHashrate.value, 0, 'pool hashrate should be 0')
  t.pass()
})

test('getSiteLiveStatus - computes utilization correctly', async (t) => {
  const tailLogMultiResponse = [
    [{ hashrate_mhs_1m_sum_aggr: 500, nominal_hashrate_mhs_sum_aggr: 1000, online_or_minor_error_miners_amount_aggr: 0, not_mining_miners_amount_aggr: 0, offline_or_sleeping_miners_amount_aggr: 0, hashrate_mhs_1m_cnt_aggr: 0, alerts_aggr: {} }],
    [{}],
    [{ container_nominal_miner_capacity_sum_aggr: 0 }]
  ]

  const listThingsResponse = [
    { id: 'pm-site', tags: ['t-powermeter'], last: { snap: { stats: { power_w: 750 } } } }
  ]

  const ctx = createMockCtx(tailLogMultiResponse, [], { nominalPowerAvailability_MW: 0.001 }, listThingsResponse)
  const req = { query: {} }

  const result = await getSiteLiveStatus(ctx, req)

  t.is(result.hashrate.utilization, 50, 'hashrate utilization should be 50%')
  t.is(result.power.utilization, 75, 'power utilization should be 75%')
  t.pass()
})

test('getSiteLiveStatus - handles zero nominal values gracefully', async (t) => {
  const tailLogMultiResponse = [
    [{ hashrate_mhs_1m_sum_aggr: 100 }],
    [{}],
    [{}]
  ]

  const ctx = createMockCtx(tailLogMultiResponse, [], { nominalPowerAvailability_MW: 0 })
  const req = { query: {} }

  const result = await getSiteLiveStatus(ctx, req)

  t.is(result.hashrate.utilization, 0, 'should return 0 when nominal hashrate is 0')
  t.is(result.power.utilization, 0, 'should return 0 when nominal power is 0')
  t.pass()
})

test('getSiteLiveStatus - aggregates multiple pool accounts from stats arrays', async (t) => {
  const tailLogMultiResponse = [
    [{ hashrate_mhs_1m_sum_aggr: 0 }],
    [{}],
    [{}]
  ]

  // One entry with two pools plus one extra entry, all stats arrays (H/s)
  const extDataResponse = [
    {
      stats: [
        { poolType: 'f2pool', hashrate: 100000000, active_workers_count: 10, worker_count: 15 },
        { poolType: 'ocean', hashrate: 150000000, active_workers_count: 15, worker_count: 20 }
      ]
    },
    { stats: [{ poolType: 'luxor', hashrate: 50000000, active_workers_count: 5, worker_count: 5 }] }
  ]

  const ctx = createMockCtx(tailLogMultiResponse, extDataResponse, {})
  const req = { query: {} }

  const result = await getSiteLiveStatus(ctx, req)

  t.is(result.pools.totalHashrate.value, 300, 'should sum pool hashrates and convert H/s to MH/s')
  t.is(result.pools.activeWorkers, 30, 'should sum active workers')
  t.is(result.pools.totalWorkers, 40, 'should sum total workers')
  t.pass()
})

test('getSiteLiveStatus - does not expose a derived sleep field', async (t) => {
  const tailLogMultiResponse = [
    [{
      hashrate_mhs_1m_sum_aggr: 0,
      online_or_minor_error_miners_amount_aggr: 80,
      not_mining_miners_amount_aggr: 5,
      offline_or_sleeping_miners_amount_aggr: 10,
      hashrate_mhs_1m_cnt_aggr: 100
    }],
    [{}],
    [{}]
  ]

  const ctx = createMockCtx(tailLogMultiResponse, [], {})
  const req = { query: {} }

  const result = await getSiteLiveStatus(ctx, req)

  t.is(result.miners.online, 80, 'online should match')
  t.is(result.miners.error, 5, 'error should match')
  t.is(result.miners.offline, 10, 'offline should match (includes sleeping)')
  t.is(result.miners.sleep, undefined, 'sleep should not be present (UI has no sleep concept)')
  t.is(result.miners.total, 100, 'total should match')
  t.pass()
})

test('getSiteLiveStatus - sums alerts across miner, powermeter and container entries', async (t) => {
  const tailLogMultiResponse = [
    [{ alerts_aggr: { critical: 1, high: 2, medium: 3 } }],
    [{ alerts_aggr: { critical: 4, high: 5, medium: 6 } }],
    [{ alerts_aggr: { critical: 7, high: 8, medium: 9 } }]
  ]

  const ctx = createMockCtx(tailLogMultiResponse, [], {})
  const req = { query: {} }

  const result = await getSiteLiveStatus(ctx, req)

  t.is(result.alerts.critical, 12, 'critical should sum across all three entry types')
  t.is(result.alerts.high, 15, 'high should sum across all three entry types')
  t.is(result.alerts.medium, 18, 'medium should sum across all three entry types')
  t.is(result.alerts.total, 45, 'total should be the overall sum')
  t.pass()
})

test('getSiteLiveStatus - queries tail-log with a 10 minute freshness window', async (t) => {
  let tailLogParams = null
  const ctx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }], featureConfig: {} },
    net_r0: {
      jRequest: async (key, method, params) => {
        if (method === 'tailLogMulti') {
          tailLogParams = params
          return []
        }
        return []
      }
    }
  })

  const before = Date.now()
  await getSiteLiveStatus(ctx, { query: {} })
  const after = Date.now()

  t.ok(tailLogParams, 'should call tailLogMulti')
  t.ok(typeof tailLogParams.start === 'number', 'should pass start to tailLogMulti')
  t.ok(tailLogParams.start >= before - 10 * 60 * 1000, 'start should be no earlier than now - 10min')
  t.ok(tailLogParams.start <= after - 10 * 60 * 1000, 'start should be now - 10min')
  t.pass()
})

test('getSiteLiveStatus - falls back to site container thing when no power meter is tagged', async (t) => {
  const tailLogMultiResponse = [[{}], [{}], [{}]]

  const listThingsResponse = [
    { id: 'other', tags: ['t-sensor-temp'], last: { snap: { stats: { power_w: 999 } } } },
    { id: 'container-site', tags: ['t-container'], last: { snap: { stats: { power_w: 1234 } } } }
  ]

  const ctx = createMockCtx(tailLogMultiResponse, [], {}, listThingsResponse)
  const req = { query: {} }

  const result = await getSiteLiveStatus(ctx, req)

  t.is(result.power.value, 1234, 'should fall back to the first t-container thing')
  t.pass()
})

test('getSiteLiveStatus - exposes site meter alerts as power alert/error', async (t) => {
  const tailLogMultiResponse = [[{}], [{}], [{}]]

  const listThingsResponse = [
    {
      id: 'pm-site',
      tags: ['t-powermeter'],
      last: {
        snap: { stats: { power_w: 500 } },
        alerts: [
          { severity: 'high', createdAt: 1769686500000, name: 'power-failure', description: 'Phase loss', message: 'L2 down' }
        ]
      }
    }
  ]

  const ctx = createMockCtx(tailLogMultiResponse, [], {}, listThingsResponse)
  const req = { query: {} }

  const result = await getSiteLiveStatus(ctx, req)

  t.is(result.power.value, 500, 'power value should come from the site meter')
  t.ok(result.power.alert.includes('(high)'), 'alert string should include severity')
  t.ok(result.power.alert.includes('power-failure'), 'alert string should include alert name')
  t.is(result.power.error, true, 'power error should be true when the meter has alerts')
  t.pass()
})

test('getSiteLiveStatus - totalSystemConsumptionHeader feature returns zero consumption', async (t) => {
  const tailLogMultiResponse = [
    [{ hashrate_mhs_1m_sum_aggr: 1000000 }],
    [{}],
    [{}]
  ]

  // listThings would return a site meter, but the feature branch must ignore it
  const listThingsResponse = [
    { id: 'pm-site', tags: ['t-powermeter'], last: { snap: { stats: { power_w: 16701560 } } } }
  ]

  const ctx = createMockCtx(tailLogMultiResponse, [], {}, listThingsResponse, { totalSystemConsumptionHeader: true })
  const req = { query: {} }

  const result = await getSiteLiveStatus(ctx, req)

  t.is(result.power.value, 0, 'power should be 0 for the system consumption header feature')
  t.is(result.power.alert, '', 'no alert for the system consumption branch')
  t.is(result.efficiency.value, 0, 'efficiency should be 0 when consumption is 0')
  t.pass()
})

test('getSiteLiveStatus - totalTransformerConsumptionHeader sums transformer power meters', async (t) => {
  const tailLogMultiResponse = [
    [{ hashrate_mhs_1m_sum_aggr: 2000000 }],
    [{}],
    [{}]
  ]

  const listThingsResponse = [
    { id: 'pm-tr1', type: 'powermeter-x', info: { pos: 'tr1' }, last: { snap: { stats: { power_w: 1000 } } } },
    { id: 'pm-tr2', type: 'powermeter-x', info: { pos: 'tr2' }, last: { snap: { stats: { power_w: 500 } } } },
    // Not a transformer power meter (pos does not match ^tr\d+$) - must be skipped
    { id: 'pm-other', type: 'powermeter-x', info: { pos: 'site' }, last: { snap: { stats: { power_w: 9999 } } } },
    // Not a power meter type - must be skipped
    { id: 'sensor-tr3', type: 'sensor-temp-x', info: { pos: 'tr3' }, last: { snap: { stats: { power_w: 7777 } } } }
  ]

  const ctx = createMockCtx(tailLogMultiResponse, [], {}, listThingsResponse, { totalTransformerConsumptionHeader: true })
  const req = { query: {} }

  const result = await getSiteLiveStatus(ctx, req)

  t.is(result.power.value, 1500, 'power should be the sum of transformer power meters only')
  // 1500 W / 2 TH/s = 750 W/TH/s
  t.is(result.efficiency.value, 750, 'efficiency should use the transformer consumption')
  t.pass()
})

test('getSiteLiveStatus - central DCS reads consumption from the site main meter', async (t) => {
  const tailLogMultiResponse = [
    [{ hashrate_mhs_1m_sum_aggr: 2000000 }],
    [{}],
    [{}]
  ]

  // DCS thing with site_main meter reporting kW, like the energy layout view
  const listThingsResponse = [
    {
      id: 'dcs-1',
      type: 'dcs-central',
      tags: ['t-dcs'],
      last: {
        snap: {
          stats: {
            dcs_specific: {
              equipment: {
                power_meters: [
                  { equipment: 'PM-1', role: 'rack', power: { value: 4000, unit: 'kW' } },
                  { equipment: 'PM-SITE', role: 'site_main', power: { value: 10.5, unit: 'kW' } }
                ]
              }
            }
          }
        }
      }
    }
  ]

  const ctx = createMockCtx(tailLogMultiResponse, [], {}, listThingsResponse, { centralDCSSetup: { enabled: true, tag: 't-dcs' } })
  const req = { query: {} }

  const result = await getSiteLiveStatus(ctx, req)

  t.is(result.power.value, 10500, 'power should be the site_main meter reading converted kW to W')
  t.is(result.power.alert, '', 'no device alert in the DCS branch')
  // 10500 W / 2 TH/s = 5250 W/TH/s
  t.is(result.efficiency.value, 5250, 'efficiency should use the DCS site meter consumption')
  t.pass()
})

test('getSiteLiveStatus - central DCS takes precedence over other consumption branches', async (t) => {
  const tailLogMultiResponse = [[{}], [{}], [{}]]

  const listThingsResponse = [
    {
      id: 'dcs-1',
      type: 'dcs-central',
      tags: ['t-dcs'],
      last: {
        snap: {
          stats: {
            dcs_specific: {
              equipment: {
                power_meters: [
                  { equipment: 'PM-SITE', role: 'site_main', power: { value: 2, unit: 'kW' } }
                ]
              }
            }
          }
        }
      }
    },
    // Transformer meter that the transformer branch would otherwise sum
    { id: 'pm-tr1', type: 'powermeter-x', info: { pos: 'tr1' }, last: { snap: { stats: { power_w: 9999 } } } }
  ]

  const ctx = createMockCtx(tailLogMultiResponse, [], {}, listThingsResponse, {
    centralDCSSetup: { enabled: true, tag: 't-dcs' },
    totalTransformerConsumptionHeader: true
  })
  const req = { query: {} }

  const result = await getSiteLiveStatus(ctx, req)

  t.is(result.power.value, 2000, 'DCS site meter should win over the transformer branch')
  t.pass()
})

test('getSiteLiveStatus - central DCS without site_main meter yields zero consumption', async (t) => {
  const tailLogMultiResponse = [[{}], [{}], [{}]]

  const listThingsResponse = [
    {
      id: 'dcs-1',
      type: 'dcs-central',
      tags: ['t-dcs'],
      last: {
        snap: {
          stats: {
            dcs_specific: {
              equipment: {
                power_meters: [
                  { equipment: 'PM-1', role: 'rack', power: { value: 4000, unit: 'kW' } }
                ]
              }
            }
          }
        }
      }
    }
  ]

  const ctx = createMockCtx(tailLogMultiResponse, [], {}, listThingsResponse, { centralDCSSetup: { enabled: true, tag: 't-dcs' } })
  const req = { query: {} }

  const result = await getSiteLiveStatus(ctx, req)

  t.is(result.power.value, 0, 'power should be 0 when no site_main meter exists')
  t.is(result.power.error, false, 'no error flag without a site meter alert source')
  t.pass()
})

test('getSiteLiveStatus - uses nominal_hashrate from taillog over globalConfig', async (t) => {
  const tailLogMultiResponse = [
    [{ hashrate_mhs_1m_sum_aggr: 500, nominal_hashrate_mhs_sum_aggr: 1000 }],
    [{}],
    [{}]
  ]

  const ctx = createMockCtx(tailLogMultiResponse, [], { nominalHashrate: 2000 })
  const req = { query: {} }

  const result = await getSiteLiveStatus(ctx, req)

  t.is(result.hashrate.nominal, 1000, 'should prefer nominal from taillog aggr')
  t.pass()
})

test('getSiteLiveStatus - falls back to globalConfig nominalHashrate', async (t) => {
  const tailLogMultiResponse = [
    [{ hashrate_mhs_1m_sum_aggr: 500, nominal_hashrate_mhs_sum_aggr: 0 }],
    [{}],
    [{}]
  ]

  const ctx = createMockCtx(tailLogMultiResponse, [], { nominalHashrate: 2000 })
  const req = { query: {} }

  const result = await getSiteLiveStatus(ctx, req)

  t.is(result.hashrate.nominal, 2000, 'should fall back to globalConfig nominalHashrate')
  t.pass()
})

// ============ getSiteOverviewGroupsStats Tests ============

function createMockDcsCtx (tailLogResponse, listThingsResponse) {
  return withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }],
      featureConfig: { centralDCSSetup: { enabled: true, tag: 't-dcs' } }
    },
    net_r0: {
      jRequest: async (key, method) => {
        if (method === 'tailLogMulti') return tailLogResponse
        if (method === 'listThings') return listThingsResponse
        return {}
      }
    }
  })
}

function createMockNoDcsCtx (tailLogResponse) {
  return withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }],
      featureConfig: { centralDCSSetup: { enabled: false } }
    },
    net_r0: {
      jRequest: async (key, method) => {
        if (method === 'tailLogMulti') return tailLogResponse
        return {}
      }
    }
  })
}

test('getSiteOverviewGroupsStats - returns groups with correct structure', async (t) => {
  const tailLogResponse = [
    [{
      hashrate_mhs_5m_container_group_sum_aggr: { 'group-1': 100000000, 'group-2': 200000000 },
      hashrate_mhs_5m_pdu_rack_group_avg_aggr: { 'group-1_rack-1': 50000000, 'group-1_rack-2': 50000000 },
      power_w_container_group_sum_aggr: { 'group-1': 50000, 'group-2': 100000 },
      power_w_pdu_rack_group_sum_aggr: { 'group-1_rack-1': 25000, 'group-1_rack-2': 25000 },
      offline_cnt: { 'group-1': 2, 'group-2': 1 },
      error_cnt: { 'group-1': 1, 'group-2': 0 },
      not_mining_cnt: { 'group-1': 0, 'group-2': 1 },
      power_mode_sleep_cnt: { 'group-1': 5, 'group-2': 3 },
      power_mode_low_cnt: { 'group-1': 10, 'group-2': 8 },
      power_mode_normal_cnt: { 'group-1': 50, 'group-2': 55 },
      power_mode_high_cnt: { 'group-1': 12, 'group-2': 12 }
    }]
  ]

  const listThingsResponse = [{
    id: 'dcs-1',
    type: 'dcs-central',
    tags: ['t-dcs'],
    last: {
      snap: {
        config: {
          mining: { total_groups: 2, racks_per_group: 4, miners_per_rack: 20 },
          energy_layout: { branches: [] }
        },
        stats: { dcs_specific: { equipment: { power_meters: [] } } }
      }
    }
  }]

  const ctx = createMockDcsCtx(tailLogResponse, listThingsResponse)
  const req = { query: {} }

  const result = await getSiteOverviewGroupsStats(ctx, req)

  t.ok(result.groups, 'should have groups')
  t.is(result.groups.length, 2, 'should have 2 groups')

  const group1 = result.groups[0]
  t.is(group1.id, 'group-1', 'group 1 should have correct id')
  t.is(group1.name, 'Group 1', 'group 1 should have correct name')
  t.ok(group1.summary, 'group should have summary')
  t.ok(group1.summary.hashrate, 'summary should have hashrate')
  t.ok(group1.summary.consumption, 'summary should have consumption')
  t.ok(group1.summary.efficiency, 'summary should have efficiency')
  t.ok(group1.status, 'group should have status')
  t.is(group1.status.offline, 2, 'offline count should match')
  t.is(group1.status.error, 1, 'error count should match')
  t.is(group1.status.sleep, 5, 'sleep count should match')
  t.ok(group1.racks, 'group should have racks')

  t.pass()
})

test('getSiteOverviewGroupsStats - handles empty miner data gracefully', async (t) => {
  // When there's no miner data, groups are determined by what's in hashrateByGroup
  // If hashrateByGroup is empty but total_groups is set, it uses total_groups
  const tailLogResponse = [
    [{
      // Empty group data - groups will be determined by total_groups config
      hashrate_mhs_5m_container_group_sum_aggr: {},
      power_w_container_group_sum_aggr: {},
      power_mode_normal_cnt: {}
    }]
  ]
  const listThingsResponse = [{
    id: 'dcs-1',
    type: 'dcs-central',
    tags: ['t-dcs'],
    last: {
      snap: {
        config: { mining: { total_groups: 2, racks_per_group: 4, miners_per_rack: 20 } },
        stats: { dcs_specific: { equipment: { power_meters: [] } } }
      }
    }
  }]

  const ctx = createMockDcsCtx(tailLogResponse, listThingsResponse)
  const req = { query: {} }

  const result = await getSiteOverviewGroupsStats(ctx, req)

  t.ok(result.groups, 'should have groups')
  t.is(result.groups.length, 2, 'should have groups from total_groups config')
  t.is(result.groups[0].status.total, 0, 'total miners should be 0')
  t.is(result.groups[0].summary.hashrate.value, 0, 'hashrate should be 0')
  t.pass()
})

test('getSiteOverviewGroupsStats - works without DCS enabled', async (t) => {
  const tailLogResponse = [
    [{
      hashrate_mhs_5m_container_group_sum_aggr: { 'group-1': 100000000 },
      power_w_container_group_sum_aggr: { 'group-1': 50000 },
      power_mode_normal_cnt: { 'group-1': 50 }
    }]
  ]

  const ctx = createMockNoDcsCtx(tailLogResponse)
  const req = { query: {} }

  const result = await getSiteOverviewGroupsStats(ctx, req)

  t.ok(result.groups, 'should have groups')
  t.is(result.groups.length, 1, 'should have 1 group from miner data')
  t.pass()
})

test('getSiteOverviewGroupsStats - builds racks for groups', async (t) => {
  const tailLogResponse = [
    [{
      hashrate_mhs_5m_container_group_sum_aggr: { 'group-1': 100000000 },
      hashrate_mhs_5m_pdu_rack_group_avg_aggr: {
        'group-1_rack-1': 30000000,
        'group-1_rack-2': 40000000,
        'group-1_rack-3': 30000000
      },
      power_w_pdu_rack_group_sum_aggr: {
        'group-1_rack-1': 15000,
        'group-1_rack-2': 20000,
        'group-1_rack-3': 15000
      },
      power_mode_normal_cnt: { 'group-1': 60 }
    }]
  ]

  const listThingsResponse = [{
    id: 'dcs-1',
    type: 'dcs-central',
    tags: ['t-dcs'],
    last: {
      snap: {
        config: { mining: { total_groups: 1, racks_per_group: 4 } },
        stats: { dcs_specific: { equipment: { power_meters: [] } } }
      }
    }
  }]

  const ctx = createMockDcsCtx(tailLogResponse, listThingsResponse)
  const req = { query: {} }

  const result = await getSiteOverviewGroupsStats(ctx, req)

  t.is(result.groups[0].racks.length, 3, 'should have 3 racks')
  t.is(result.groups[0].racks[0].id, 'rack-1', 'first rack should be rack-1')
  t.ok(result.groups[0].racks[0].hashrate.value > 0, 'rack should have hashrate')
  t.ok(result.groups[0].racks[0].consumption.value > 0, 'rack should have consumption')
  t.pass()
})

// ============ getSiteEfficiency Tests ============

function createMockEfficiencyCtx (tailLogResponse, listThingsResponse) {
  return withDataProxy({
    conf: {
      orks: [{ rpcPublicKey: 'key1' }],
      featureConfig: { centralDCSSetup: { enabled: true, tag: 't-dcs' } }
    },
    net_r0: {
      jRequest: async (key, method) => {
        if (method === 'tailLogMulti') return tailLogResponse
        if (method === 'listThings') return listThingsResponse
        return {}
      }
    }
  })
}

test('getSiteEfficiency - returns correct structure', async (t) => {
  const tailLogResponse = [
    [{
      hashrate_mhs_5m_container_group_sum_aggr: {
        'group-1': 500000000000,
        'group-2': 500000000000,
        'group-3': 500000000000,
        'group-4': 500000000000
      }
    }]
  ]

  const listThingsResponse = [{
    id: 'dcs-1',
    type: 'dcs-central',
    tags: ['t-dcs'],
    last: {
      snap: {
        config: {
          mining: { racks_per_group: 4, miners_per_rack: 20 },
          energy_layout: {
            site_meter: 'PM-SITE',
            branches: [
              { board: 'DB-1', transformer: 'TX-1', meter: 'PM-1', feeds: 'Groups 1-2' },
              { board: 'DB-2', transformer: 'TX-2', meter: 'PM-2', feeds: 'Groups 3-4' },
              { board: 'DB-CCM', meter: 'PM-CCM', feeds: 'Cooling & Auxiliary' }
            ]
          }
        },
        stats: {
          dcs_specific: {
            equipment: {
              power_meters: [
                { equipment: 'PM-SITE', role: 'site_main', name: 'Site Main', power: { value: 10000, unit: 'kW' } },
                { equipment: 'PM-1', role: 'rack', name: 'Meter 1', power: { value: 4000, unit: 'kW' } },
                { equipment: 'PM-2', role: 'rack', name: 'Meter 2', power: { value: 4000, unit: 'kW' } },
                { equipment: 'PM-CCM', role: 'auxiliary', name: 'CCM', power: { value: 2000, unit: 'kW' } }
              ],
              distribution_boards: [
                { equipment: 'DB-1', name: 'Distribution Board 1' },
                { equipment: 'DB-2', name: 'Distribution Board 2' }
              ],
              transformers: [
                { equipment: 'TX-1', name: 'Transformer 1' },
                { equipment: 'TX-2', name: 'Transformer 2' }
              ]
            }
          }
        }
      }
    }
  }]

  const ctx = createMockEfficiencyCtx(tailLogResponse, listThingsResponse)
  const req = { query: {} }

  const result = await getSiteEfficiency(ctx, req)

  t.ok(result.summary, 'should have summary')
  t.ok(result.summary.site_efficiency, 'should have site_efficiency')
  t.ok(result.summary.mining_efficiency, 'should have mining_efficiency')
  t.ok(result.summary.total_consumption, 'should have total_consumption')
  t.ok(result.summary.ca_overhead, 'should have ca_overhead')
  t.is(result.summary.total_consumption.unit, 'MW', 'total_consumption unit should be MW')

  t.ok(result.efficiency_per_meter, 'should have efficiency_per_meter')
  t.ok(Array.isArray(result.efficiency_per_meter), 'efficiency_per_meter should be array')
  t.is(result.efficiency_per_meter.length, 2, 'should have 2 rack meters')

  t.ok(result.consumption_breakdown, 'should have consumption_breakdown')
  t.ok(Array.isArray(result.consumption_breakdown), 'consumption_breakdown should be array')

  t.pass()
})

test('getSiteEfficiency - computes efficiency correctly', async (t) => {
  // 1 TH/s = 1,000,000 MH/s, so 2 TH/s total
  const tailLogResponse = [
    [{
      hashrate_mhs_5m_container_group_sum_aggr: {
        'group-1': 1000000,
        'group-2': 1000000
      }
    }]
  ]

  const listThingsResponse = [{
    id: 'dcs-1',
    type: 'dcs-central',
    tags: ['t-dcs'],
    last: {
      snap: {
        config: {
          mining: { racks_per_group: 4, miners_per_rack: 20 },
          energy_layout: {
            site_meter: 'PM-SITE',
            branches: [
              { board: 'DB-1', transformer: 'TX-1', meter: 'PM-1', feeds: 'Groups 1-2' }
            ]
          }
        },
        stats: {
          dcs_specific: {
            equipment: {
              power_meters: [
                // Site uses 100 kW, mining uses 80 kW for 2 TH/s = 40 W/TH
                { equipment: 'PM-SITE', role: 'site_main', power: { value: 100, unit: 'kW' } },
                { equipment: 'PM-1', role: 'rack', power: { value: 80, unit: 'kW' } }
              ],
              distribution_boards: [],
              transformers: []
            }
          }
        }
      }
    }
  }]

  const ctx = createMockEfficiencyCtx(tailLogResponse, listThingsResponse)
  const req = { query: {} }

  const result = await getSiteEfficiency(ctx, req)

  // Mining efficiency: 80 kW * 1000 / 2 TH/s = 40000 W/TH
  t.is(result.summary.mining_efficiency.value, 40000, 'mining efficiency should be 40000 W/TH')
  // Site efficiency: 100 kW * 1000 / 2 TH/s = 50000 W/TH
  t.is(result.summary.site_efficiency.value, 50000, 'site efficiency should be 50000 W/TH')
  t.pass()
})

test('getSiteEfficiency - computes C&A overhead', async (t) => {
  const tailLogResponse = [
    [{
      hashrate_mhs_5m_container_group_sum_aggr: { 'group-1': 1000000 }
    }]
  ]

  const listThingsResponse = [{
    id: 'dcs-1',
    type: 'dcs-central',
    tags: ['t-dcs'],
    last: {
      snap: {
        config: {
          mining: {},
          energy_layout: {
            site_meter: 'PM-SITE',
            branches: [
              { board: 'DB-1', meter: 'PM-1', feeds: 'Groups 1-2' },
              { board: 'DB-CCM', meter: 'PM-CCM', feeds: 'Cooling' }
            ]
          }
        },
        stats: {
          dcs_specific: {
            equipment: {
              power_meters: [
                { equipment: 'PM-SITE', role: 'site_main', power: { value: 1000, unit: 'kW' } },
                { equipment: 'PM-1', role: 'rack', power: { value: 800, unit: 'kW' } },
                { equipment: 'PM-CCM', role: 'auxiliary', power: { value: 200, unit: 'kW' } }
              ],
              distribution_boards: [],
              transformers: []
            }
          }
        }
      }
    }
  }]

  const ctx = createMockEfficiencyCtx(tailLogResponse, listThingsResponse)
  const req = { query: {} }

  const result = await getSiteEfficiency(ctx, req)

  // C&A overhead: 200 / 1000 * 100 = 20%
  t.is(result.summary.ca_overhead.value, 20, 'C&A overhead should be 20%')
  t.is(result.summary.ca_overhead.unit, '%', 'C&A overhead unit should be %')
  t.pass()
})

test('getSiteEfficiency - throws error when DCS data not found', async (t) => {
  const tailLogResponse = [[{ hashrate_mhs_5m_container_group_sum_aggr: {} }]]
  const listThingsResponse = [] // No DCS thing

  const ctx = createMockEfficiencyCtx(tailLogResponse, listThingsResponse)
  const req = { query: {} }

  try {
    await getSiteEfficiency(ctx, req)
    t.fail('should have thrown error')
  } catch (err) {
    t.is(err.message, 'ERR_DCS_DATA_NOT_FOUND', 'should throw ERR_DCS_DATA_NOT_FOUND')
  }
  t.pass()
})

test('getSiteEfficiency - handles zero hashrate gracefully', async (t) => {
  const tailLogResponse = [
    [{
      hashrate_mhs_5m_container_group_sum_aggr: { 'group-1': 0, 'group-2': 0 }
    }]
  ]

  const listThingsResponse = [{
    id: 'dcs-1',
    type: 'dcs-central',
    tags: ['t-dcs'],
    last: {
      snap: {
        config: {
          mining: {},
          energy_layout: {
            site_meter: 'PM-SITE',
            branches: [
              { board: 'DB-1', meter: 'PM-1', feeds: 'Groups 1-2' }
            ]
          }
        },
        stats: {
          dcs_specific: {
            equipment: {
              power_meters: [
                { equipment: 'PM-SITE', role: 'site_main', power: { value: 1000, unit: 'kW' } },
                { equipment: 'PM-1', role: 'rack', power: { value: 800, unit: 'kW' } }
              ],
              distribution_boards: [],
              transformers: []
            }
          }
        }
      }
    }
  }]

  const ctx = createMockEfficiencyCtx(tailLogResponse, listThingsResponse)
  const req = { query: {} }

  const result = await getSiteEfficiency(ctx, req)

  t.is(result.summary.site_efficiency.value, 0, 'site efficiency should be 0 when hashrate is 0')
  t.is(result.summary.mining_efficiency.value, 0, 'mining efficiency should be 0 when hashrate is 0')
  t.pass()
})

test('getSiteEfficiency - builds consumption breakdown', async (t) => {
  const tailLogResponse = [
    [{
      hashrate_mhs_5m_container_group_sum_aggr: { 'group-1': 1000000 }
    }]
  ]

  const listThingsResponse = [{
    id: 'dcs-1',
    type: 'dcs-central',
    tags: ['t-dcs'],
    last: {
      snap: {
        config: {
          mining: {},
          energy_layout: {
            site_meter: 'PM-SITE',
            branches: [
              { board: 'DB-1', meter: 'PM-1', feeds: 'Groups 1-2' },
              { board: 'DB-2', meter: 'PM-2', feeds: 'Groups 3-4' }
            ]
          }
        },
        stats: {
          dcs_specific: {
            equipment: {
              power_meters: [
                { equipment: 'PM-SITE', role: 'site_main', name: 'Site Main', power: { value: 1000, unit: 'kW' } },
                { equipment: 'PM-1', role: 'rack', power: { value: 600, unit: 'kW' } },
                { equipment: 'PM-2', role: 'rack', power: { value: 400, unit: 'kW' } }
              ],
              distribution_boards: [],
              transformers: []
            }
          }
        }
      }
    }
  }]

  const ctx = createMockEfficiencyCtx(tailLogResponse, listThingsResponse)
  const req = { query: {} }

  const result = await getSiteEfficiency(ctx, req)

  t.ok(result.consumption_breakdown.length >= 3, 'should have at least 3 entries in breakdown')

  const siteEntry = result.consumption_breakdown.find(e => e.source === 'Site Main')
  t.ok(siteEntry, 'should have site main entry')
  t.is(siteEntry.percent, 100, 'site main should be 100%')

  const db1Entry = result.consumption_breakdown.find(e => e.source === 'DB-1')
  t.ok(db1Entry, 'should have DB-1 entry')
  t.is(db1Entry.percent, 60, 'DB-1 should be 60%')

  const db2Entry = result.consumption_breakdown.find(e => e.source === 'DB-2')
  t.ok(db2Entry, 'should have DB-2 entry')
  t.is(db2Entry.percent, 40, 'DB-2 should be 40%')

  t.pass()
})

test('getSiteEfficiency - handles efficiency per meter correctly', async (t) => {
  // 1000 TH/s per group = 1,000,000,000 MH/s
  const tailLogResponse = [
    [{
      hashrate_mhs_5m_container_group_sum_aggr: {
        'group-1': 1000000000000, // 1000 TH/s
        'group-2': 1000000000000 // 1000 TH/s
      }
    }]
  ]

  const listThingsResponse = [{
    id: 'dcs-1',
    type: 'dcs-central',
    tags: ['t-dcs'],
    last: {
      snap: {
        config: {
          mining: { racks_per_group: 4, miners_per_rack: 20 },
          energy_layout: {
            site_meter: 'PM-SITE',
            branches: [
              { board: 'DB-1', transformer: 'TX-1', meter: 'PM-1', feeds: 'Groups 1-2' }
            ]
          }
        },
        stats: {
          dcs_specific: {
            equipment: {
              power_meters: [
                { equipment: 'PM-SITE', role: 'site_main', power: { value: 50000, unit: 'kW' } },
                // 40000 kW for 2000 TH/s = 20 W/TH
                { equipment: 'PM-1', role: 'rack', power: { value: 40000, unit: 'kW' } }
              ],
              distribution_boards: [{ equipment: 'DB-1', name: 'Board 1' }],
              transformers: [{ equipment: 'TX-1', name: 'Transformer 1' }]
            }
          }
        }
      }
    }
  }]

  const ctx = createMockEfficiencyCtx(tailLogResponse, listThingsResponse)
  const req = { query: {} }

  const result = await getSiteEfficiency(ctx, req)

  t.is(result.efficiency_per_meter.length, 1, 'should have 1 meter entry')
  const meter = result.efficiency_per_meter[0]
  t.is(meter.board, 'DB-1', 'board should be DB-1')
  t.is(meter.board_name, 'Board 1', 'board_name should be Board 1')
  t.is(meter.transformer, 'TX-1', 'transformer should be TX-1')
  t.is(meter.transformer_name, 'Transformer 1', 'transformer_name should be Transformer 1')
  t.is(meter.feeds, 'Groups 1-2', 'feeds should match')
  t.is(meter.efficiency.value, 20, 'efficiency should be 20 W/TH')
  t.is(meter.miners, 160, 'miners should be 2 groups * 4 racks * 20 miners = 160')
  t.pass()
})
