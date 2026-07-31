'use strict'

const test = require('brittle')
const { exportRoute } = require('../../../workers/lib/server/handlers/export.handlers')

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMockReply () {
  let _code = 200
  let _body = null
  const _headers = {}
  const reply = {
    get statusCode () { return _code },
    get body () { return _body },
    get headers () { return _headers },
    code (statusCode) {
      _code = statusCode
      return reply
    },
    header (name, value) {
      _headers[name.toLowerCase()] = value
      return reply
    },
    send (body) {
      _body = body
      return body
    }
  }
  return reply
}

function makeMockReq (query = {}) {
  return {
    query,
    _info: {
      authToken: 'test-token',
      user: { metadata: { email: 'ops@example.com' } }
    }
  }
}

function makeMockCtx (requestDataMap) {
  return {
    noAuth: false,
    authLib: {
      tokenHasPerms: async () => true
    },
    dataProxy: { requestDataMap }
  }
}

async function drain (stream) {
  let out = ''
  for await (const chunk of stream) out += chunk
  return out
}

function makeMiner (id) {
  return {
    id: `miner-${id}`,
    type: 'antminer_s19',
    code: `MC${id}`,
    tags: ['t-miner'],
    info: { site: 'site-1', container: 'container-7', pos: `pos-${id}`, serialNum: `SN${id}`, macAddress: `00:00:00:00:00:${id}` },
    address: `10.0.0.${id}`,
    last: {
      alerts: [],
      snap: {
        stats: { status: 'mining', hashrate_mhs: { t_5m: 100000000 }, power_w: 3500, temperature_c: 65, uptime_ms: 1000 },
        config: { power_mode: 'normal', firmware_ver: 'v1', pool_config: [{ username: 'pool.worker1' }] }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

test('exportRoute rejects unknown type with 400', async (t) => {
  const reply = makeMockReply()
  await exportRoute(makeMockCtx(), makeMockReq({ type: 'nope' }), reply)

  t.is(reply.statusCode, 400)
  t.is(reply.body.error, 'ERR_EXPORT_TYPE_UNKNOWN')
})

test('exportRoute rejects missing required per-type params with 400', async (t) => {
  const cases = [
    [{ type: 'container-miner-stats' }, 'ERR_EXPORT_CONTAINER_REQUIRED'],
    [{ type: 'historical-forecast' }, 'ERR_EXPORT_RANGE_REQUIRED'],
    [{ type: 'historical-forecast', start: 5, end: 1 }, 'ERR_EXPORT_RANGE_INVALID'],
    [{ type: 'historical-miner-kpi', start: 1, end: 5 }, 'ERR_EXPORT_STAT_KEY_REQUIRED'],
    [{ type: 'historical-miner-kpi', statKey: 'stat-5m' }, 'ERR_EXPORT_RANGE_REQUIRED']
  ]
  for (const [query, error] of cases) {
    const reply = makeMockReply()
    await exportRoute(makeMockCtx(), makeMockReq(query), reply)
    t.is(reply.statusCode, 400, `${query.type} -> 400`)
    t.is(reply.body.error, error)
  }
})

test('exportRoute rejects invalid timezone with 400', async (t) => {
  const reply = makeMockReply()
  const ctx = makeMockCtx(async () => [[makeMiner('1')]])
  await exportRoute(ctx, makeMockReq({ type: 'miner-stats', timezone: 'Not/AZone' }), reply)

  t.is(reply.statusCode, 400)
  t.is(reply.body.error, 'ERR_EXPORT_TIMEZONE_INVALID')
})

test('exportRoute returns 404 when the export has no rows', async (t) => {
  const reply = makeMockReply()
  const ctx = makeMockCtx(async () => [[]])
  await exportRoute(ctx, makeMockReq({ type: 'miner-stats' }), reply)

  t.is(reply.statusCode, 404)
  t.is(reply.body.error, 'ERR_EXPORT_NO_DATA')
})

// ─────────────────────────────────────────────────────────────────────────────
// miner-stats
// ─────────────────────────────────────────────────────────────────────────────

test('miner-stats streams CSV with download headers and paginates listThings', async (t) => {
  const offsets = []
  const ctx = makeMockCtx(async (method, params) => {
    t.is(method, 'listThings')
    offsets.push(params.offset)
    if (params.offset === 0) {
      return [Array.from({ length: params.limit }, (_, i) => makeMiner(String(i)))]
    }
    return [[makeMiner('last')]]
  })
  const reply = makeMockReply()
  await exportRoute(ctx, makeMockReq({ type: 'miner-stats', format: 'csv' }), reply)

  t.is(reply.statusCode, 200)
  t.is(reply.headers['content-type'], 'text/csv; charset=utf-8')
  t.ok(/^attachment; filename="realtime_miners_stats_.+\.csv"$/.test(reply.headers['content-disposition']))
  t.is(reply.headers['cache-control'], 'no-store')

  const csv = await drain(reply.body)
  const lines = csv.split('\n')
  t.is(lines[0], 'id,status,powerMode,site,container,position,shortCode,hashrateMhs,powerW,workerName,activePool,serialNumber,macAddress,type,temperatureC,alerts,uptimeMs,ip')
  t.is(lines[1], '"miner-0","mining","normal","site-1","container-7","pos-0","MC0","100000000","3500","worker1","pool","SN0","00:00:00:00:00:0","antminer_s19","65","","1000","10.0.0.0"')
  t.is(lines.length, 1 + 100 + 1)
  t.alike(offsets, [0, 100])
})

test('miner-stats JSON export matches the {dateExported, miners} wrapper', async (t) => {
  const ctx = makeMockCtx(async () => [[makeMiner('1')]])
  const reply = makeMockReply()
  await exportRoute(ctx, makeMockReq({ type: 'miner-stats', format: 'json' }), reply)

  t.is(reply.headers['content-type'], 'application/json; charset=utf-8')
  const parsed = JSON.parse(await drain(reply.body))
  t.ok(parsed.dateExported)
  t.is(parsed.miners.length, 1)
  t.is(parsed.miners[0].id, 'miner-1')
  t.is(parsed.miners[0].workerName, 'worker1')
  t.is(parsed.miners[0].activePool, 'pool')
  t.is(parsed.miners[0].shortCode, 'MC1')
})

// ─────────────────────────────────────────────────────────────────────────────
// container-miner-stats
// ─────────────────────────────────────────────────────────────────────────────

test('container-miner-stats filters by container tag and computes efficiency', async (t) => {
  let seenQuery = null
  const ctx = makeMockCtx(async (method, params) => {
    seenQuery = params.query
    return [[makeMiner('9')]]
  })
  const reply = makeMockReply()
  await exportRoute(ctx, makeMockReq({ type: 'container-miner-stats', container: '7' }), reply)

  t.alike(seenQuery, {
    $and: [
      { tags: { $in: ['container-7'] } },
      { tags: { $in: ['t-miner'] } }
    ]
  })

  const csv = await drain(reply.body)
  const lines = csv.split('\n')
  t.is(lines[0], 'id,type,site,container,position,serialNumber,macAddress,ipAddress,firmwareVersion,status,powerMode,hashrateMhs,efficiencyWThs,powerW,temperatureC,workerName,activePool,alerts,uptimeMs')
  t.ok(lines[1].includes('"35"'))
  t.ok(/^attachment; filename="container_miners_stats_.+\.csv"$/.test(reply.headers['content-disposition']))
})

test('container-miner-stats leaves efficiency empty without power or hashrate', async (t) => {
  const miner = makeMiner('9')
  miner.last.snap.stats.power_w = 0
  const ctx = makeMockCtx(async () => [[miner]])
  const reply = makeMockReply()
  await exportRoute(ctx, makeMockReq({ type: 'container-miner-stats', container: '7', format: 'json' }), reply)

  const parsed = JSON.parse(await drain(reply.body))
  t.is(parsed.miners[0].efficiencyWThs, '')
})

// ─────────────────────────────────────────────────────────────────────────────
// forecast types
// ─────────────────────────────────────────────────────────────────────────────

function forecastPayload () {
  return {
    againstMiningPercent: 12,
    againstSellingPercent: 34,
    expectedRevenue: 1000,
    revenueIfAllMine: 1200,
    revenueIfAllSell: 800,
    hourlyForecast: [
      {
        start: 1767225600000,
        end: 1767229200000,
        spotPrice: 55,
        miningRevenue: 10,
        decision: 'mine',
        availableEnergy: '1',
        expectedRevenue: 9,
        expectedRevenuePerMwh: 3
      },
      {
        start: 1767229200000,
        end: 1767232800000,
        spotPrice: 60,
        decision: 'not_mine',
        available: 0
      }
    ]
  }
}

test('forecast-overview exports 19 columns with normalized availability', async (t) => {
  const ctx = makeMockCtx(async (method, params) => {
    t.is(method, 'getWrkExtData')
    t.is(params.type, 'electricity')
    t.is(params.query.key, 'forecast')
    return [[forecastPayload()]]
  })
  const reply = makeMockReply()
  await exportRoute(ctx, makeMockReq({ type: 'forecast-overview' }), reply)

  const csv = await drain(reply.body)
  const lines = csv.split('\n')
  const header = lines[0].split(',')
  t.is(header.length, 19)
  t.is(header[0], 'startUtc')
  t.is(header[16], 'available')
  t.is(header[18], 'expectedRevenuePerMwh')
  t.ok(lines[1].includes('"2026-01-01T00:00:00.000Z"'))
  t.ok(lines[1].includes('"mine"'))
  t.ok(lines[1].includes('"1"'))
  t.ok(lines[2].includes('"not_mine"'))
})

test('historical-forecast passes range through and exports 17 columns with summary in JSON', async (t) => {
  let seenParams = null
  const ctx = makeMockCtx(async (method, params) => {
    seenParams = params
    return [[forecastPayload()]]
  })
  const reply = makeMockReply()
  await exportRoute(ctx, makeMockReq({ type: 'historical-forecast', start: 1, end: 2, format: 'json' }), reply)

  t.is(seenParams.query.key, 'forecastHistory')
  t.is(seenParams.start, 1)
  t.is(seenParams.end, 2)

  const parsed = JSON.parse(await drain(reply.body))
  t.alike(parsed.summary, {
    againstMiningPercent: 12,
    againstSellingPercent: 34,
    expectedRevenue: 1000,
    revenueIfAllMine: 1200,
    revenueIfAllSell: 800
  })
  t.is(parsed.hourlyForecast.length, 2)
  t.is(parsed.hourlyForecast[0].available, 1)
  t.is(parsed.hourlyForecast[0].expectedRevenue, undefined)
  t.ok(/^attachment; filename="historical_forecast_.+\.json"$/.test(reply.headers['content-disposition']))
})

// ─────────────────────────────────────────────────────────────────────────────
// historical-miner-kpi
// ─────────────────────────────────────────────────────────────────────────────

test('historical-miner-kpi joins miner and container series by ts', async (t) => {
  let seenParams = null
  const minerSeries = [
    { ts: 2000, hashrate_mhs_1m_sum_aggr: 200, power_w_sum_aggr: 7000, power_mode_group_aggr: { 'miner-1': 'normal' }, status_group_aggr: { 'miner-1': 'mining' } },
    { ts: 1000, hashrate_mhs_1m_sum_aggr: 100, power_w_sum_aggr: 3500, power_mode_group_aggr: { 'miner-1': 'sleep' }, status_group_aggr: { 'miner-1': 'sleeping' } },
    { hashrate_mhs_1m_sum_aggr: 999 }
  ]
  const containerSeries = [
    {
      ts: 1000,
      container_specific_stats_group_aggr: {
        'container-m221-gabbani-1': { production_power_w: 50, consumption_power_w: 20, system_consumption_power_w: 5 },
        'container-other-1': { production_power_w: 999, consumption_power_w: 999, system_consumption_power_w: 999 }
      }
    }
  ]
  const ctx = makeMockCtx(async (method, params) => {
    t.is(method, 'tailLogMulti')
    seenParams = params
    return [[minerSeries, containerSeries]]
  })
  const reply = makeMockReply()
  await exportRoute(ctx, makeMockReq({ type: 'historical-miner-kpi', statKey: 'stat-5m', start: 0, end: 3000 }), reply)

  t.alike(seenParams.keys, [
    { key: 'stat-5m', type: 'miner', tag: 't-miner' },
    { key: 'stat-5m', type: 'container', tag: 't-container' }
  ])

  const csv = await drain(reply.body)
  const lines = csv.split('\n')
  t.is(lines[0], 'time,totalMinersHashrateMHS,totalMinerPowerW,Power Mode miner-1,Status miner-1,totalSystemConsumptionW,gridExportPowerW,gridImportPowerW')
  t.is(lines.length, 3)
  t.ok(lines[1].includes('"200"'))
  t.ok(lines[2].includes('"3505"'))
  t.ok(lines[2].includes('"50"'))
  t.ok(lines[2].includes('"20"'))
  t.ok(/^attachment; filename="historical_mining_stats_5m_.+\.csv"$/.test(reply.headers['content-disposition']))
})
