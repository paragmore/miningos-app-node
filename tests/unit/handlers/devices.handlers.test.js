'use strict'

const test = require('brittle')
const {
  getContainers,
  getCabinets,
  getCabinetById,
  groupIntoCabinets,
  getCabinetPos,
  collectFilterPaths,
  buildContainerProjection,
  buildMingoFilter,
  queryAndPaginate
} = require('../../../workers/lib/server/handlers/devices.handlers')
const { flattenRpcResults } = require('../../../workers/lib/utils')
const { createMockCtxWithOrks } = require('../helpers/mockHelpers')

test('flattenRpcResults - flattens multi-ork arrays', (t) => {
  const results = [
    [{ id: 'm1', ip: '10.0.0.1' }, { id: 'm2', ip: '10.0.0.2' }],
    [{ id: 'm3', ip: '10.0.0.3' }]
  ]
  const items = flattenRpcResults(results)
  t.is(items.length, 3, 'should flatten all items')
  t.pass()
})

test('flattenRpcResults - deduplicates by id', (t) => {
  const results = [
    [{ id: 'm1', ip: '10.0.0.1' }],
    [{ id: 'm1', ip: '10.0.0.1' }]
  ]
  const items = flattenRpcResults(results)
  t.is(items.length, 1, 'should deduplicate by id')
  t.pass()
})

test('flattenRpcResults - handles error results', (t) => {
  const results = [{ error: 'timeout' }, [{ id: 'm1' }]]
  const items = flattenRpcResults(results)
  t.is(items.length, 1, 'should skip error results')
  t.pass()
})

test('flattenRpcResults - handles null input', (t) => {
  const items = flattenRpcResults(null)
  t.is(items.length, 0, 'should return empty array')
  t.pass()
})

test('flattenRpcResults - handles empty input', (t) => {
  const items = flattenRpcResults([])
  t.is(items.length, 0, 'should return empty array')
  t.pass()
})

test('flattenRpcResults - handles nested data property', (t) => {
  const results = [
    { data: [{ id: 'm1' }, { id: 'm2' }] }
  ]
  const items = flattenRpcResults(results)
  t.is(items.length, 2, 'should extract from data property')
  t.pass()
})

test('buildMingoFilter - no filter no search returns empty object', (t) => {
  const result = buildMingoFilter(null, null)
  t.alike(result, {}, 'should return empty object')
  t.pass()
})

test('buildMingoFilter - filter only returns filter as-is', (t) => {
  const filter = { type: 's19' }
  const result = buildMingoFilter(filter, null)
  t.alike(result, filter, 'should return filter directly')
  t.pass()
})

test('buildMingoFilter - search only returns $or filter', (t) => {
  const result = buildMingoFilter(null, 'alpha')
  t.ok(result.$or, 'should have $or')
  t.is(result.$or.length, 2, 'should have 2 search conditions')
  t.pass()
})

test('buildMingoFilter - filter and search combined with $and', (t) => {
  const filter = { $or: [{ type: 's19' }, { type: 's21' }] }
  const result = buildMingoFilter(filter, 'alpha')
  t.ok(result.$and, 'should wrap in $and')
  t.is(result.$and.length, 2, 'should have filter and search')
  t.ok(result.$and[0].$or, 'first should be user filter with $or')
  t.ok(result.$and[1].$or, 'second should be search filter with $or')
  t.pass()
})

test('queryAndPaginate - filters and paginates', (t) => {
  const items = [
    { id: 'm1', type: 's19' },
    { id: 'm2', type: 's21' },
    { id: 'm3', type: 's19' }
  ]
  const result = queryAndPaginate(items, {
    filter: { type: 's19' },
    fields: null,
    sort: null,
    search: null,
    offset: 0,
    limit: 1
  })
  t.is(result.total, 2, 'total should be filtered count')
  t.is(result.page.length, 1, 'page should respect limit')
  t.pass()
})

test('collectFilterPaths - collects field paths through operators', (t) => {
  const paths = collectFilterPaths({
    $and: [
      { 'last.snap.stats.status': { $in: ['online'] } },
      { $or: [{ type: 'antbox' }, { 'info.pos': { $regex: 'c1' } }] }
    ]
  })
  t.ok(paths.has('last.snap.stats.status'), 'should collect status path')
  t.ok(paths.has('type'), 'should collect type path')
  t.ok(paths.has('info.pos'), 'should collect pos path')
  t.pass()
})

test('buildContainerProjection - includes requested fields plus sort and filter paths', (t) => {
  const projection = buildContainerProjection({
    fields: { 'last.snap.stats.status': 1 },
    sort: { 'last.snap.stats.power_w': 1 },
    filter: { 'last.snap.stats.humidity_percent': { $gt: 10 } }
  })
  t.is(projection.id, 1, 'should always include id')
  t.is(projection['last.snap.stats.status'], 1, 'should include requested field')
  t.is(projection['last.snap.stats.power_w'], 1, 'should include sort path')
  t.is(projection['last.snap.stats.humidity_percent'], 1, 'should include filter path')
  t.pass()
})

test('buildContainerProjection - ignores exclusion-style fields', (t) => {
  const projection = buildContainerProjection({
    fields: { info: 0 },
    sort: null,
    filter: null
  })
  t.absent(projection.info === 0, 'should not forward exclusions to the ork')
  t.is(projection['last.snap.stats.status'], 1, 'should fall back to default projection')
  t.pass()
})

test('buildContainerProjection - defaults include last snap stats for list columns', (t) => {
  const projection = buildContainerProjection({ fields: null, sort: null, filter: null })
  t.is(projection['last.snap.stats.status'], 1, 'should include status by default')
  t.is(projection['last.snap.stats.ambient_temp_c'], 1, 'should include ambient temp by default')
  t.is(projection['last.alerts'], 1, 'should include alerts by default')
  t.pass()
})

test('getContainers - happy path', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async () => [
      { id: 'c1', type: 'bitdeer-d40' },
      { id: 'c2', type: 'antbox-hydro' }
    ]
  )

  const result = await getContainers(mockCtx, { query: {} })
  t.ok(result.containers, 'should return containers array')
  t.is(result.containers.length, 2, 'should have 2 containers')
  t.is(result.total, 2, 'should report total')
  t.pass()
})

test('getContainers - with filter', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async () => [
      { id: 'c1', type: 'bitdeer-d40', status: 'online' },
      { id: 'c2', type: 'antbox-hydro', status: 'offline' }
    ]
  )

  const result = await getContainers(mockCtx, { query: { filter: '{"status":"online"}' } })
  t.is(result.containers.length, 1, 'should filter containers')
  t.is(result.containers[0].status, 'online', 'should match filter')
  t.pass()
})

test('getContainers - filter applies before pagination', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async () => [
      { id: 'c1', status: 'offline' },
      { id: 'c2', status: 'online' },
      { id: 'c3', status: 'offline' },
      { id: 'c4', status: 'online' },
      { id: 'c5', status: 'online' }
    ]
  )

  const result = await getContainers(mockCtx, {
    query: { filter: '{"status":"online"}', offset: 1, limit: 1 }
  })
  t.is(result.total, 3, 'total should be filtered count, not page count')
  t.is(result.containers.length, 1, 'should respect limit')
  t.is(result.containers[0].id, 'c4', 'offset should apply to filtered set')
  t.pass()
})

test('getContainers - sort applies before pagination', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async () => [
      { id: 'c2' },
      { id: 'c3' },
      { id: 'c1' }
    ]
  )

  const result = await getContainers(mockCtx, {
    query: { sort: '{"id":1}', offset: 0, limit: 2 }
  })
  t.is(result.containers[0].id, 'c1', 'should sort across the full set')
  t.is(result.containers[1].id, 'c2', 'should return sorted page')
  t.is(result.total, 3, 'total should be full count')
  t.pass()
})

test('getContainers - projects sort and filter paths at the ork', async (t) => {
  let capturedParams = null
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async (key, method, params) => {
      capturedParams = params
      return []
    }
  )

  await getContainers(mockCtx, {
    query: {
      fields: '{"last.snap.stats.status":1}',
      sort: '{"last.snap.stats.power_w":-1}',
      filter: '{"last.snap.stats.humidity_percent":{"$gt":10}}'
    }
  })
  t.is(capturedParams.fields['last.snap.stats.status'], 1, 'should project requested field')
  t.is(capturedParams.fields['last.snap.stats.power_w'], 1, 'should project sort path')
  t.is(capturedParams.fields['last.snap.stats.humidity_percent'], 1, 'should project filter path')
  t.pass()
})

test('getContainers - empty results', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => [])

  const result = await getContainers(mockCtx, { query: {} })
  t.is(result.containers.length, 0, 'should return empty array')
  t.is(result.total, 0, 'total should be 0')
  t.pass()
})

const CABINET_DEVICES = [
  {
    id: 'pm-lv1',
    type: 'powermeter-abb-m4m',
    code: 'thing-pm-lv1',
    rack: 'r1',
    info: { pos: 'lv1_lv1', connectedDevices: ['container-1'] },
    last: { snap: { stats: { power_w: 5000 } } }
  },
  {
    id: 'ts-lv1',
    type: 'sensor-temp-x',
    code: 'thing-ts-lv1',
    rack: 'r1',
    info: { pos: 'lv1_lv1' },
    last: { snap: { stats: { temp_c: 41 } }, alerts: [{ uuid: 'a1' }] },
    comments: [{ text: 'check fan' }]
  },
  {
    id: 'ts-lv1-tr',
    type: 'sensor-temp-x',
    code: 'thing-ts-lv1-tr',
    rack: 'r1',
    info: { pos: 'lv1_tr1' },
    last: { snap: { stats: { temp_c: 55 } } }
  },
  {
    id: 'pm-lv2',
    type: 'powermeter-abb-m4m',
    code: 'thing-pm-lv2',
    rack: 'r2',
    info: { pos: 'lv2_pm2', connectedDevices: ['container-2'] },
    last: { snap: { stats: { power_w: 3000 } } }
  }
]

test('groupIntoCabinets - groups by underscore pos root', (t) => {
  const cabinets = groupIntoCabinets(CABINET_DEVICES)
  t.is(cabinets.length, 2, 'should create 2 cabinets')

  const lv1 = cabinets.find(c => c.id === 'lv1')
  t.ok(lv1, 'should have lv1 cabinet')
  t.is(lv1.type, 'cabinet', 'should have type cabinet')
  t.is(lv1.rootPowerMeter.id, 'pm-lv1', 'root pos device should be root power meter')
  t.is(lv1.rootTempSensor.id, 'ts-lv1', 'root pos device should be root temp sensor')
  t.is(lv1.transformerTempSensor.id, 'ts-lv1-tr', 'tr pos device should be transformer sensor')
  t.is(lv1.tempSensors.length, 1, 'non-root temp sensors should be listed')
  t.is(lv1.tempSensors[0].id, 'ts-lv1-tr', 'transformer sensor is also a non-root temp sensor')
  t.alike(lv1.connectedDevices, ['container-1'], 'should union connected devices')
  t.pass()
})

test('groupIntoCabinets - non-root power meters go to powerMeters', (t) => {
  const cabinets = groupIntoCabinets(CABINET_DEVICES)
  const lv2 = cabinets.find(c => c.id === 'lv2')
  t.ok(lv2, 'should have lv2 cabinet')
  t.absent(lv2.rootPowerMeter, 'lv2 has no root power meter')
  t.is(lv2.powerMeters.length, 1, 'non-root power meter should be listed')
  t.is(lv2.powerMeters[0].last.snap.stats.power_w, 3000, 'should keep device stats')
  t.pass()
})

test('groupIntoCabinets - enriches alerts and comments with source device', (t) => {
  const cabinets = groupIntoCabinets(CABINET_DEVICES)
  const lv1 = cabinets.find(c => c.id === 'lv1')

  t.is(lv1.alerts.length, 1, 'should collect device alerts')
  t.is(lv1.alerts[0].uuid, 'a1', 'should keep alert payload')
  t.is(lv1.alerts[0].sensorData.id, 'ts-lv1', 'should attach source device')

  t.is(lv1.comments.length, 1, 'should collect device comments')
  t.is(lv1.comments[0].pos, 'lv1_lv1', 'should attach device pos')
  t.is(lv1.comments[0].thingId, 'ts-lv1', 'should attach device id')
  t.is(lv1.comments[0].rackId, 'r1', 'should attach rack')
  t.pass()
})

test('groupIntoCabinets - drops devices without pos root', (t) => {
  const cabinets = groupIntoCabinets([
    { id: 'd1', type: 'powermeter-x' },
    { id: 'd2', type: 'powermeter-x', info: { pos: '' } }
  ])
  t.is(cabinets.length, 0, 'should drop devices with blank root')
  t.pass()
})

test('groupIntoCabinets - passes through non-cabinet device types', (t) => {
  const cabinets = groupIntoCabinets([
    { id: 'd1', type: 'powermeter-x', info: { pos: 'lv1_lv1' } },
    { id: 'other', type: 'sensor-vibration' }
  ])
  t.is(cabinets.length, 2, 'should keep other devices')
  t.ok(cabinets.find(c => c.id === 'other'), 'other device should pass through ungrouped')
  t.pass()
})

test('groupIntoCabinets - empty input', (t) => {
  const cabinets = groupIntoCabinets([])
  t.is(cabinets.length, 0, 'should return empty array')
  t.pass()
})

test('getCabinetPos - splits pos on underscore', (t) => {
  t.alike(getCabinetPos({ info: { pos: 'lv1_tr2' } }), { root: 'lv1', devicePos: 'tr2' })
  t.alike(getCabinetPos({}), { root: '', devicePos: undefined })
  t.pass()
})

test('getCabinets - happy path with grouping', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async () => CABINET_DEVICES
  )

  const result = await getCabinets(mockCtx, { query: {} })
  t.ok(result.cabinets, 'should return cabinets array')
  t.is(result.cabinets.length, 2, 'should group into 2 cabinets')
  t.is(result.total, 2, 'should report total')
  t.is(result.cabinets[0].id, 'lv1', 'should sort by id by default')
  t.is(result.cabinets[1].id, 'lv2', 'should sort by id by default')
  t.pass()
})

test('getCabinets - empty results', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => [])

  const result = await getCabinets(mockCtx, { query: {} })
  t.is(result.cabinets.length, 0, 'should return empty array')
  t.is(result.total, 0, 'total should be 0')
  t.pass()
})

test('getCabinets - with pagination', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async () => [
      { id: 'd1', type: 'powermeter-x', info: { pos: 'lv1_lv1' } },
      { id: 'd2', type: 'powermeter-x', info: { pos: 'lv2_lv2' } },
      { id: 'd3', type: 'powermeter-x', info: { pos: 'lv3_lv3' } }
    ]
  )

  const result = await getCabinets(mockCtx, { query: { offset: '1', limit: '1' } })
  t.is(result.total, 3, 'total should reflect all cabinets')
  t.is(result.cabinets.length, 1, 'should return limited results')
  t.is(result.cabinets[0].id, 'lv2', 'should apply offset on sorted cabinets')
  t.pass()
})

test('getCabinets - device-level filter applies before grouping', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async () => CABINET_DEVICES
  )

  const result = await getCabinets(mockCtx, {
    query: { filter: '{"rack":"r2"}' }
  })
  t.is(result.total, 1, 'should only group matching devices')
  t.is(result.cabinets[0].id, 'lv2', 'should build cabinet from matched devices')
  t.pass()
})

test('getCabinets - search matches device id, code and pos', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async () => CABINET_DEVICES
  )

  const result = await getCabinets(mockCtx, { query: { search: 'pm-lv2' } })
  t.is(result.total, 1, 'should match by device id')
  t.is(result.cabinets[0].id, 'lv2', 'should return the matched cabinet')
  t.pass()
})

test('getCabinetById - happy path', async (t) => {
  let capturedParams = null
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async (key, method, params) => {
      capturedParams = params
      return CABINET_DEVICES.filter(d => d.info.pos.startsWith('lv1'))
    }
  )

  const result = await getCabinetById(mockCtx, { params: { id: 'lv1' }, query: {} })
  t.ok(result.cabinet, 'should return cabinet')
  t.is(result.cabinet.id, 'lv1', 'should match requested id')
  t.is(result.cabinet.rootPowerMeter.id, 'pm-lv1', 'should include grouped devices')
  t.ok(
    capturedParams.query.$and[0]['info.pos'].$regex.startsWith('^lv1'),
    'should scope the ork query to the cabinet root'
  )
  t.pass()
})

test('getCabinetById - not found', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async () => []
  )

  try {
    await getCabinetById(mockCtx, { params: { id: 'nonexistent' }, query: {} })
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_CABINET_NOT_FOUND', 'should throw not found error')
    t.is(err.statusCode, 404, 'should have 404 status code')
  }
  t.pass()
})
