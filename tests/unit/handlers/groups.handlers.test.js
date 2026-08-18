'use strict'

const test = require('brittle')
const {
  getGroupStats
} = require('../../../workers/lib/server/handlers/groups.handlers')

function createMockTailLogEntry () {
  return {
    hashrate_mhs_5m_pdu_rack_group_sum_aggr: {
      'group-1_1-1': 5000000000,
      'group-1_1-2': 4000000000,
      'group-2_2-1': 3000000000,
      'group-2_2-2': 6000000000
    },
    power_w_pdu_rack_group_sum_aggr: {
      'group-1_1-1': 500000,
      'group-1_1-2': 400000,
      'group-2_2-1': 300000,
      'group-2_2-2': 600000
    },
    efficiency_w_ths_pdu_rack_group_avg_aggr: {
      'group-1_1-1': 6,
      'group-1_1-2': 6,
      'group-2_2-1': 6,
      'group-2_2-2': 6
    }
  }
}

function createMockDcsThing () {
  return {
    id: 'dcs-1',
    type: 'wrk-dcs-siemens',
    tags: ['t-dcs'],
    last: {
      snap: {
        config: {
          mining: { total_groups: 2, racks_per_group: 2, miners_per_rack: 20 }
        }
      }
    }
  }
}

function createMockCtx ({ dcsEnabled = true, tailLogEntry = createMockTailLogEntry(), dcsThing = createMockDcsThing() } = {}) {
  return {
    conf: {
      featureConfig: dcsEnabled ? { centralDCSSetup: { enabled: true, tag: 't-dcs' } } : {}
    },
    dataProxy: {
      requestDataMap: async (method) => {
        if (method === 'tailLogMulti') return [[[tailLogEntry]]]
        if (method === 'listThings') return dcsEnabled ? [[dcsThing]] : [[]]
        return []
      }
    }
  }
}

// ==================== getGroupStats ====================

test('getGroupStats - accepts the real aggregation key spelling', async (t) => {
  const ctx = createMockCtx()
  const res = await getGroupStats(ctx, { query: { racks: 'group-1_1-1' } })

  t.is(res.totalCount, 1)
  t.is(res.data[0].id, 'group-1_rack-1', 'public id is preserved')
  t.is(res.data[0].consumption.value, 500, '500000 W → 500 kW')
  t.pass()
})

test('getGroupStats - returns per-rack data with real values mapped to synth ids', async (t) => {
  const ctx = createMockCtx()
  const result = await getGroupStats(ctx, { query: { racks: 'group-1_rack-1,group-1_rack-2' } })

  t.is(result.totalCount, 2)
  const [first, second] = result.data
  t.is(first.id, 'group-1_rack-1')
  t.alike(first.group, { id: 'group-1', name: 'Group 1' })
  t.is(first.miners_count, 20)
  t.ok(first.hashrate.value > 0, 'mapped to group-1_1-1 real values')
  t.ok(first.consumption.value > 0)
  t.ok(first.efficiency.value > 0)

  t.is(second.id, 'group-1_rack-2')
  t.ok(second.hashrate.value > 0, 'mapped to group-1_1-2 real values')
  t.pass()
})

test('getGroupStats - cross-group selection', async (t) => {
  const ctx = createMockCtx()
  const result = await getGroupStats(ctx, { query: { racks: 'group-1_rack-1,group-2_rack-2' } })

  t.is(result.totalCount, 2)
  const ids = result.data.map(r => r.id)
  t.alike(ids, ['group-1_rack-1', 'group-2_rack-2'])
  result.data.forEach(rack => t.ok(rack.hashrate.value > 0))
  t.pass()
})

test('getGroupStats - unknown rack ids are dropped', async (t) => {
  const ctx = createMockCtx()
  const result = await getGroupStats(ctx, { query: { racks: 'group-1_rack-1,group-99_rack-99' } })

  t.is(result.totalCount, 1)
  t.is(result.data[0].id, 'group-1_rack-1')
  t.pass()
})

test('getGroupStats - missing racks throws', async (t) => {
  const ctx = createMockCtx()
  try {
    await getGroupStats(ctx, { query: {} })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_RACKS')
  }
  t.pass()
})

test('getGroupStats - empty racks string throws', async (t) => {
  const ctx = createMockCtx()
  try {
    await getGroupStats(ctx, { query: { racks: '' } })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_MISSING_RACKS')
  }
  t.pass()
})

test('getGroupStats - returns empty data when DCS disabled', async (t) => {
  const ctx = createMockCtx({ dcsEnabled: false })
  const result = await getGroupStats(ctx, { query: { racks: 'group-1_rack-1' } })
  t.is(result.totalCount, 0)
  t.alike(result.data, [])
  t.pass()
})
