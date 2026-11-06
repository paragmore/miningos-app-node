'use strict'

const test = require('brittle')
const {
  toConsumptionWindows,
  toPoolHashrateMinutes,
  getLiveConsumption,
  getLivePoolHashrate
} = require('../../../workers/lib/server/handlers/realtime.handlers')

const HOUR = 60 * 60 * 1000

function dcsCtx (requestData) {
  return {
    conf: { featureConfig: { centralDCSSetup: { enabled: true, tag: 't-dcs-siemens' } } },
    dataProxy: { requestData }
  }
}

test('toConsumptionWindows unwraps ork arrays and keeps gaps as null', (t) => {
  const res = [[
    { ts: 20000, site_power_w_avg: [] },
    { ts: 10000, site_power_w_avg: [9.5e6] },
    { ts: 30000, site_power_w_avg: [0] }
  ]]

  t.alike(toConsumptionWindows(res), [
    { ts: 10000, avg: 9.5e6 },
    { ts: 20000, avg: null },
    { ts: 30000, avg: 0 }
  ])
  t.alike(toConsumptionWindows(null), [])
})

test('toPoolHashrateMinutes sums ocean accounts and nulls incomplete minutes', (t) => {
  const res = [
    [
      { ts: 60000, stats: [{ poolType: 'ocean', username: 'a', hashrate: 5 }, { poolType: 'ocean', username: 'b', hashrate: 3 }] },
      { ts: 120000, stats: [{ poolType: 'ocean', username: 'a', hashrate: 5 }, { poolType: 'ocean', username: 'b', hashrate: null }] },
      { ts: 180000, stats: [{ poolType: 'ocean', username: 'a', hashrate: 0 }] }
    ],
    [
      { ts: 60000, stats: [{ poolType: 'f2pool', username: 'c', hashrate: 100 }] },
      { ts: 240000, stats: [{ poolType: 'f2pool', username: 'c', hashrate: 100 }] }
    ]
  ]

  t.alike(toPoolHashrateMinutes(res), [
    { ts: 60000, hashrate: 8 },
    { ts: 120000, hashrate: null },
    { ts: 180000, hashrate: 0 },
    { ts: 240000, hashrate: null }
  ])
})

test('getLiveConsumption reads the dcs power-10s log with an explicit limit', async (t) => {
  const reqs = []
  const ctx = dcsCtx(async (method, req) => {
    reqs.push({ method, req })
    return [[{ ts: req.end - 5000, site_power_w_avg: [1] }]]
  })

  const res = await getLiveConsumption(ctx, { query: { lookbackHours: 1 } })

  t.is(res.windowMs, 10000)
  t.is(reqs.length, 12)
  t.is(res.log.length, 1)
  t.is(reqs[0].method, 'tailLog')
  t.is(reqs[0].req.type, 'dcs-siemens')
  t.is(reqs[0].req.tag, 't-dcs-siemens')
  t.is(reqs[0].req.key, 'power-10s')
  t.is(reqs[0].req.limit, Math.ceil((reqs[0].req.end - reqs[0].req.start) / 10000) + 2)
  t.alike(reqs[0].req.aggrFields, { site_power_w_avg: 1 })
})

test('getLiveConsumption serves later polls from memory and honours since', async (t) => {
  let calls = 0
  const ctx = dcsCtx(async (method, req) => {
    calls++
    return [[{ ts: req.end - 1000, site_power_w_avg: [1] }]]
  })

  const first = await getLiveConsumption(ctx, { query: { lookbackHours: 72 } })
  const lastTs = first.log.at(-1).ts
  const next = await getLiveConsumption(ctx, { query: { lookbackHours: 72, since: lastTs } })

  t.is(calls, 12)
  t.alike(next.log, [])
})

test('getLiveConsumption trims to the requested lookback', async (t) => {
  const ctx = dcsCtx(async (method, req) => [[
    { ts: req.end - 1000, site_power_w_avg: [1] }
  ]])

  const res = await getLiveConsumption(ctx, { query: { lookbackHours: 6 } })
  const now = Date.now()

  t.ok(res.log.every(row => row.ts > now - 6 * HOUR - 1000))
})

test('getLiveConsumption returns an empty log without a central DCS', async (t) => {
  const ctx = { conf: { featureConfig: {} }, dataProxy: { requestData: () => t.fail('no rpc expected') } }
  t.alike(await getLiveConsumption(ctx, { query: { lookbackHours: 6 } }), { windowMs: 10000, log: [] })
})

test('getLivePoolHashrate reads hashrate-1m from every ork', async (t) => {
  const reqs = []
  const ctx = {
    conf: {},
    dataProxy: {
      requestDataMap: async (method, req) => {
        reqs.push({ method, req })
        return [[{ ts: req.query.end - 30000, stats: [{ poolType: 'ocean', username: 'a', hashrate: 7 }] }]]
      }
    }
  }

  const res = await getLivePoolHashrate(ctx, { query: { lookbackHours: 72 } })

  t.is(res.intervalMs, 60000)
  t.is(res.poolType, 'ocean')
  t.is(res.log.length, 3)
  t.ok(res.log.every(row => row.hashrate === 7))
  t.is(reqs.length, 3)
  t.is(reqs[0].method, 'getWrkExtData')
  t.is(reqs[0].req.type, 'minerpool')
  t.is(reqs[0].req.query.key, 'hashrate-1m')
})
