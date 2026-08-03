'use strict'

const test = require('brittle')
const handlers = require('../../../workers/lib/server/handlers/spare.parts.handlers')
const { createMockCtxWithOrks } = require('../helpers/mockHelpers')

const WO_RACK = 'inventory-work_order-rack-x'
const PART_RACK = 'inventory-miner_part-psu-rack-1'
const PART = {
  id: 'p-1',
  code: 'PSU-WM-CB6_V5-01',
  rack: PART_RACK,
  info: { location: 'Lab', status: 'active' }
}
const REPLACED_PART = {
  id: 'p-out',
  code: 'CB-AM-CB_1111-02',
  rack: PART_RACK,
  info: { location: 'miner.room', status: 'faulty' }
}
const OPEN_WO = {
  id: 'wo-1',
  code: 'IVI-2-0001',
  type: 'inventory-work_order',
  info: { status: 'open', partsMoves: [] }
}
const CLOSED_WO = {
  id: 'wo-1',
  code: 'IVI-2-0001',
  type: 'inventory-work_order',
  info: { status: 'closed', partsMoves: [] }
}

const mockAuthLib = {
  getTokenPerms: async () => ({ permissions: ['inventory:rw', 'actions:rw'] })
}
const userMeta = (email = 'op@test') => ({
  _info: { authToken: 'tok', user: { metadata: { email } } }
})

function buildCtx ({ wo = OPEN_WO, part = PART, replaced = REPLACED_PART, pushResults = {} } = {}) {
  const pushed = []
  const handler = async (_key, method, params) => {
    if (method === 'listThings') {
      if (params.query?.type === 'inventory-work_order') return wo ? [wo] : []
      if (params.query?.id === PART.id) return part ? [part] : []
      if (params.query?.code) return replaced && params.query.code === replaced.code ? [replaced] : []
      return []
    }
    if (method === 'pushAction') {
      pushed.push(params)
      return pushResults[params.params[0].rackId] ?? { id: `act-${pushed.length}`, errors: [] }
    }
    return null
  }
  const ctx = createMockCtxWithOrks([{ rpcPublicKey: 'k' }], handler)
  ctx.authLib = mockAuthLib
  ctx._workOrderRackId = WO_RACK
  return { ctx, pushed }
}

test('handlers: updateSparePart rejects location/status changes without workOrderId', async (t) => {
  const { ctx } = buildCtx()
  await t.exception(
    () => handlers.updateSparePart(ctx, {
      ...userMeta(),
      params: { id: PART.id },
      body: { rackId: PART_RACK, info: { location: 'site.lab' } }
    }),
    /ERR_PART_MOVE_REQUIRES_WO/
  )
})

test('handlers: updateSparePart rejects when WO is closed', async (t) => {
  const { ctx } = buildCtx({ wo: CLOSED_WO })
  await t.exception(
    () => handlers.updateSparePart(ctx, {
      ...userMeta(),
      params: { id: PART.id },
      body: { rackId: PART_RACK, workOrderId: 'wo-1', info: { location: 'site.lab' } }
    }),
    /ERR_WO_INVALID_STATUS_TRANSITION/
  )
})

test('handlers: updateSparePart 404s when WO is missing', async (t) => {
  const { ctx } = buildCtx({ wo: null })
  await t.exception(
    () => handlers.updateSparePart(ctx, {
      ...userMeta(),
      params: { id: PART.id },
      body: { rackId: PART_RACK, workOrderId: 'wo-missing', info: { location: 'site.lab' } }
    }),
    /ERR_WORK_ORDER_NOT_FOUND/
  )
})

test('handlers: updateSparePart pushes part update + WO partsMoves append on a valid move', async (t) => {
  const { ctx, pushed } = buildCtx()
  const out = await handlers.updateSparePart(ctx, {
    ...userMeta(),
    params: { id: PART.id },
    body: { rackId: PART_RACK, workOrderId: 'wo-1', info: { location: 'site.lab' } }
  })

  t.is(pushed.length, 2, 'two actions pushed (part + WO)')

  const partAction = pushed.find(p => p.params[0].rackId === PART_RACK)
  t.is(partAction.action, 'updateThing')
  t.is(partAction.params[0].info.location, 'site.lab')
  t.is(partAction.params[0].info.workOrderId, 'wo-1', 'workOrderId injected into part info')
  t.is(partAction.params[0].info.workOrderCode, 'IVI-2-0001', 'workOrderCode injected too')

  const woAction = pushed.find(p => p.params[0].rackId === WO_RACK)
  const moves = woAction.params[0].info.partsMoves
  t.is(moves.length, 1)
  t.is(moves[0].partId, PART.id)
  t.is(moves[0].partCode, PART.code)
  t.is(moves[0].fromLocation, 'Lab')
  t.is(moves[0].toLocation, 'site.lab')
  t.is(moves[0].workOrderCode, 'IVI-2-0001')

  t.ok(out.move, 'response includes the move record')
})

test('handlers: updateSparePart aborts WO append when the part pushAction returned errors', async (t) => {
  const handler = async (_key, method, params) => {
    if (method === 'listThings') {
      if (params.query?.type === 'inventory-work_order') return [OPEN_WO]
      return [PART]
    }
    if (method === 'pushAction') {
      const isPart = params.params[0].rackId === PART_RACK
      return { id: null, errors: isPart ? ['ERR_RACK_DOWN'] : [] }
    }
    return null
  }
  const ctx = createMockCtxWithOrks([{ rpcPublicKey: 'k' }], handler)
  ctx.authLib = mockAuthLib
  ctx._workOrderRackId = WO_RACK
  await t.exception(
    () => handlers.updateSparePart(ctx, {
      ...userMeta(),
      params: { id: PART.id },
      body: { rackId: PART_RACK, workOrderId: 'wo-1', info: { location: 'site.lab' } }
    }),
    /ERR_PART_UPDATE_PUSH_FAILED:ERR_RACK_DOWN/
  )
})

test('handlers: updateSparePart skips WO checks when only non-move fields change', async (t) => {
  const { ctx, pushed } = buildCtx()
  await handlers.updateSparePart(ctx, {
    ...userMeta(),
    params: { id: PART.id },
    body: { rackId: PART_RACK, info: { serialNum: 'SN-NEW' } }
  })
  t.is(pushed.length, 1, 'only part update pushed; no WO append')
  t.is(pushed[0].params[0].info.serialNum, 'SN-NEW')
  t.absent(pushed[0].params[0].info.workOrderId, 'no WO injected for non-move')
})

test('handlers: updateSparePart records top-level remarks on the move entry and keeps it off the part', async (t) => {
  const { ctx, pushed } = buildCtx()
  await handlers.updateSparePart(ctx, {
    ...userMeta(),
    params: { id: PART.id },
    body: { rackId: PART_RACK, workOrderId: 'wo-1', remarks: 'Not reachable', info: { location: 'miner.room' } }
  })
  const woAction = pushed.find(p => p.params[0].rackId === WO_RACK)
  const move = woAction.params[0].info.partsMoves[0]
  t.is(move.remarks, 'Not reachable')
  t.is(move.role, 'original')
  const partAction = pushed.find(p => p.params[0].rackId === PART_RACK)
  t.absent(partAction.params[0].info.remarks, 'remarks are move metadata, not written to the part record')
})

test('handlers: updateSparePart falls back to info.reason for remarks', async (t) => {
  const { ctx, pushed } = buildCtx()
  await handlers.updateSparePart(ctx, {
    ...userMeta(),
    params: { id: PART.id },
    body: { rackId: PART_RACK, workOrderId: 'wo-1', info: { location: 'miner.room', reason: 'hardware_error' } }
  })
  const woAction = pushed.find(p => p.params[0].rackId === WO_RACK)
  t.is(woAction.params[0].info.partsMoves[0].remarks, 'hardware_error')
})

test('handlers: updateSparePart marks a replacement and links the replaced part', async (t) => {
  const { ctx, pushed } = buildCtx()
  const out = await handlers.updateSparePart(ctx, {
    ...userMeta(),
    params: { id: PART.id },
    body: { rackId: PART_RACK, workOrderId: 'wo-1', replacesPartCode: REPLACED_PART.code, info: { location: 'site.warehouse' } }
  })
  const woAction = pushed.find(p => p.params[0].rackId === WO_RACK)
  const move = woAction.params[0].info.partsMoves[0]
  t.is(move.role, 'replacement')
  t.is(move.replacesPartCode, REPLACED_PART.code)
  t.is(move.replacesPartId, REPLACED_PART.id, 'server resolves the replaced part id from its code')
  t.is(out.move.role, 'replacement')
})

test('handlers: updateSparePart 400s when replacesPartCode does not resolve to a part', async (t) => {
  const { ctx } = buildCtx({ replaced: null })
  await t.exception(
    () => handlers.updateSparePart(ctx, {
      ...userMeta(),
      params: { id: PART.id },
      body: { rackId: PART_RACK, workOrderId: 'wo-1', replacesPartCode: 'NOPE-0001', info: { location: 'site.warehouse' } }
    }),
    /ERR_REPLACES_PART_NOT_FOUND/
  )
})

test('handlers: updateSparePart rejects a part replacing itself', async (t) => {
  const { ctx } = buildCtx()
  await t.exception(
    () => handlers.updateSparePart(ctx, {
      ...userMeta(),
      params: { id: PART.id },
      body: { rackId: PART_RACK, workOrderId: 'wo-1', replacesPartCode: PART.code, info: { location: 'site.warehouse' } }
    }),
    /ERR_REPLACES_PART_SELF/
  )
})

test('handlers: updateSparePart treats a replacement as a move and requires a workOrderId', async (t) => {
  const { ctx } = buildCtx()
  await t.exception(
    () => handlers.updateSparePart(ctx, {
      ...userMeta(),
      params: { id: PART.id },
      body: { rackId: PART_RACK, replacesPartCode: REPLACED_PART.code, info: {} }
    }),
    /ERR_PART_MOVE_REQUIRES_WO/
  )
})

function buildRegisterCtx ({ pushResult } = {}) {
  const pushed = []
  const handler = async (_key, method, params) => {
    if (method === 'pushAction') {
      pushed.push(params)
      return pushResult ?? { id: `act-${pushed.length}`, errors: [] }
    }
    return null
  }
  const ctx = createMockCtxWithOrks([{ rpcPublicKey: 'k' }], handler)
  ctx.authLib = mockAuthLib
  ctx._workOrderRackId = WO_RACK
  return { ctx, pushed }
}

test('handlers: registerSparePart rejects invalid deviceType', async (t) => {
  const { ctx } = buildRegisterCtx()
  await t.exception(
    () => handlers.registerSparePart(ctx, {
      ...userMeta(),
      body: { rackId: PART_RACK, info: { deviceType: 'cooling', deviceModel: 'X', serialNum: 'SN' } }
    }),
    /ERR_INVALID_DEVICE_TYPE/
  )
})

test('handlers: registerSparePart rejects missing deviceModel / serialNum', async (t) => {
  const { ctx } = buildRegisterCtx()
  await t.exception(
    () => handlers.registerSparePart(ctx, {
      ...userMeta(),
      body: { rackId: PART_RACK, info: { deviceType: 'psu', serialNum: 'SN' } }
    }),
    /ERR_DEVICE_MODEL_REQUIRED/
  )
  await t.exception(
    () => handlers.registerSparePart(ctx, {
      ...userMeta(),
      body: { rackId: PART_RACK, info: { deviceType: 'psu', deviceModel: 'M' } }
    }),
    /ERR_SERIAL_NUM_REQUIRED/
  )
})

test('handlers: registerSparePart fires part + Type-1 WO pushActions in parallel and returns action ids', async (t) => {
  const { ctx, pushed } = buildRegisterCtx()
  const out = await handlers.registerSparePart(ctx, {
    ...userMeta(),
    body: { rackId: PART_RACK, info: { deviceType: 'psu', deviceModel: 'PSU-WM-CB6_V5', serialNum: 'SN-99', notes: 'NOTES' } }
  })

  t.is(pushed.length, 2, 'one part action, one WO action')
  const partAction = pushed.find(p => p.params[0].rackId === PART_RACK)
  const woAction = pushed.find(p => p.params[0].rackId === WO_RACK)
  t.is(partAction.action, 'registerThing')
  t.is(woAction.action, 'registerThing')
  t.alike(partAction.params[0].opts, {}, 'part registration carries empty opts so device racks (miners) accept it')
  t.is(woAction.params[0].opts, undefined, 'WO registration carries no opts')
  t.is(woAction.params[0].info.type, 1, 'Type-1 WO')
  t.is(woAction.params[0].info.notes, 'NOTES', 'operator note recorded on the register WO')
  t.is(woAction.params[0].info.partsMoves[0].fromLocation, null)
  t.is(woAction.params[0].info.partsMoves[0].toLocation, 'site.warehouse')
  t.is(woAction.params[0].info.partsMoves[0].partId, out.partId, 'WO partsMoves entry links to the pre-generated partId')

  t.ok(out.partId, 'returns partId')
  t.ok(out.workOrderId, 'returns workOrderId')
  t.ok(out.partActionId, 'returns partActionId for the client to poll')
  t.ok(out.workOrderActionId, 'returns workOrderActionId for the client to poll')
  t.alike(out.errors, [], 'no errors on happy path')
})

test('handlers: registerSparePart surfaces ork-side errors in the response', async (t) => {
  const { ctx } = buildRegisterCtx({ pushResult: { id: null, errors: ['ERR_RACK_DOWN'] } })
  const out = await handlers.registerSparePart(ctx, {
    ...userMeta(),
    body: { rackId: PART_RACK, info: { deviceType: 'psu', deviceModel: 'X', serialNum: 'SN-X' } }
  })
  t.alike(out.errors.sort(), ['ERR_RACK_DOWN', 'ERR_RACK_DOWN'])
  t.is(out.partActionId, null)
})

test('handlers: registerSparePartsBatch creates one shared register WO carrying every part and attaches the note', async (t) => {
  const { ctx, pushed } = buildRegisterCtx()
  const out = await handlers.registerSparePartsBatch(ctx, {
    ...userMeta(),
    body: {
      rackId: PART_RACK,
      note: 'Pallets 1-3',
      parts: [
        { deviceType: 'psu', deviceModel: 'PSU-A', serialNum: 'SN-1' },
        { deviceType: 'psu', deviceModel: 'PSU-A', serialNum: 'SN-2' },
        { deviceType: 'psu', deviceModel: 'PSU-A', serialNum: 'SN-3' }
      ]
    }
  })

  t.is(pushed.length, 4, 'three part actions + one shared WO action')
  const woAction = pushed.find(p => p.params[0].rackId === WO_RACK)
  const partActions = pushed.filter(p => p.params[0].rackId === PART_RACK)
  t.is(partActions.length, 3, 'one registerThing per part')

  const woInfo = woAction.params[0].info
  t.is(woInfo.type, 1, 'single Type-1 register WO')
  t.is(woInfo.deviceCount, 3)
  t.is(woInfo.partsMoves.length, 3, 'register WO carries every part')
  t.is(woInfo.notes, 'Pallets 1-3', 'note recorded on the register WO')
  t.alike(woInfo.partsMoves.map(m => m.partId).sort(), out.parts.map(p => p.partId).sort(), 'WO links every returned part')

  t.is(woAction.params[0].opts, undefined, 'WO registration carries no opts')
  for (const pa of partActions) {
    t.is(pa.params[0].info.notes, 'Pallets 1-3', 'note attached to each registered part')
    t.alike(pa.params[0].opts, {}, 'each part registration carries empty opts so device racks accept it')
  }
  t.is(out.parts.length, 3, 'returns a result row per part')
  t.alike(out.errors, [], 'no errors on happy path')
})

test('handlers: registerSparePartsBatch rejects the whole batch if any part is invalid', async (t) => {
  const { ctx, pushed } = buildRegisterCtx()
  await t.exception(
    () => handlers.registerSparePartsBatch(ctx, {
      ...userMeta(),
      body: {
        rackId: PART_RACK,
        parts: [
          { deviceType: 'psu', deviceModel: 'PSU-A', serialNum: 'SN-1' },
          { deviceType: 'psu', deviceModel: 'PSU-A' }
        ]
      }
    }),
    /ERR_SERIAL_NUM_REQUIRED/
  )
  t.is(pushed.length, 0, 'nothing pushed when any part fails validation')
})

function listFlow ({ items = [], total = 0 } = {}) {
  let lastList, lastCount
  const handler = async (_key, method, params) => {
    if (method === 'listThings') { lastList = params; return items }
    if (method === 'getThingsCount') { lastCount = params; return total }
    return null
  }
  const ctx = createMockCtxWithOrks([{ rpcPublicKey: 'k' }], handler)
  return {
    ctx,
    get lastList () { return lastList },
    get lastCount () { return lastCount }
  }
}

test('handlers: listSpareParts excludes WO things via type $ne and paginates', async (t) => {
  const flow = listFlow({ items: [{ id: 'p1' }, { id: 'p2' }], total: 9 })
  const out = await handlers.listSpareParts(flow.ctx, { query: { offset: 0, limit: 2 } })
  t.alike(flow.lastList.query.type, { $ne: 'inventory-work_order' }, 'WOs excluded by mingo')
  t.alike(flow.lastCount.query.type, { $ne: 'inventory-work_order' }, 'count excludes WOs too')
  t.alike(out.data.map(o => o.id), ['p1', 'p2'])
  t.is(out.totalCount, 9)
  t.is(out.hasMore, true)
})

test('handlers: listSpareParts honors an explicit type filter (overrides $ne default)', async (t) => {
  const flow = listFlow()
  await handlers.listSpareParts(flow.ctx, { query: { query: '{"type":"inventory-miner_part-psu"}' } })
  t.is(flow.lastList.query.type, 'inventory-miner_part-psu')
})

test('handlers: listSpareParts maps location/status shortcuts to info.* mingo paths', async (t) => {
  const flow = listFlow()
  await handlers.listSpareParts(flow.ctx, {
    query: { location: 'site.lab', status: 'faulty' }
  })
  t.is(flow.lastList.query['info.location'], 'site.lab')
  t.is(flow.lastList.query['info.status'], 'faulty')
})

test('handlers: listSpareParts ?q builds case-insensitive $or against code / serialNum / macAddress', async (t) => {
  const flow = listFlow()
  await handlers.listSpareParts(flow.ctx, { query: { q: 'AB:CD:EF' } })
  const or = flow.lastList.query.$or
  t.is(or.length, 3)
  t.alike(or[0], { code: { $regex: 'AB:CD:EF', $options: 'i' } })
  t.alike(or[1], { 'info.serialNum': { $regex: 'AB:CD:EF', $options: 'i' } })
  t.alike(or[2], { 'info.macAddress': { $regex: 'AB:CD:EF', $options: 'i' } })
})

test('handlers: listSpareParts ?q escapes regex metacharacters', async (t) => {
  const flow = listFlow()
  await handlers.listSpareParts(flow.ctx, { query: { q: 'a.b+c*' } })
  t.is(flow.lastList.query.$or[0].code.$regex, 'a\\.b\\+c\\*')
})

test('handlers: listSpareParts ANDs location/status/q in a single query payload', async (t) => {
  const flow = listFlow()
  await handlers.listSpareParts(flow.ctx, {
    query: { location: 'site.lab', status: 'faulty', q: 'PS-' }
  })
  const q = flow.lastList.query
  t.is(q['info.location'], 'site.lab')
  t.is(q['info.status'], 'faulty')
  t.ok(Array.isArray(q.$or) && q.$or.length === 3)
})

test('handlers: getRepairHistory returns moves matching part id, newest first', async (t) => {
  const wos = [
    {
      id: 'wo-a',
      code: 'IVI-2-0001',
      info: {
        partsMoves: [
          { partId: 'p-1', ts: 100, fromLocation: 'Lab', toLocation: 'Field' },
          { partId: 'other', ts: 110 }
        ]
      }
    },
    {
      id: 'wo-b',
      code: 'IVI-2-0002',
      info: {
        partsMoves: [
          { partId: 'p-1', ts: 200, fromLocation: 'Field', toLocation: 'Lab' }
        ]
      }
    }
  ]
  const ctx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'k' }],
    async (_k, _m, params) => params.query?.['info.partsMoves.partId'] === 'p-1' ? wos : []
  )
  const out = await handlers.getRepairHistory(ctx, { params: { id: 'p-1' }, query: {} })
  t.is(out.totalCount, 2)
  t.is(out.data[0].ts, 200, 'newest first')
  t.is(out.data[0].workOrderCode, 'IVI-2-0002')
  t.is(out.data[1].ts, 100)
  t.is(out.data[1].workOrderCode, 'IVI-2-0001')
})
