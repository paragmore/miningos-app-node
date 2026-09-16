'use strict'

const test = require('brittle')
const {
  getWorkOrderRackId,
  submitWorkOrderAction
} = require('../../../workers/lib/server/lib/work.orders')

const RACK_ID = 'inventory-work_order-rack-x'

const woReq = (email = 'op@test') => ({
  _info: { authToken: 'tok', user: { metadata: { email } } }
})

function buildCtx ({
  racks = [{ id: RACK_ID }],
  pushResult = { id: 'action-1', errors: [] },
  perms = ['inventory:rw', 'work_order:rw', 'actions:rw'],
  captured
} = {}) {
  return {
    authLib: {
      getTokenPerms: async () => ({ permissions: perms })
    },
    dataProxy: {
      requestData: async (method, payload, errorHandler) => {
        if (captured) {
          captured.calls = captured.calls || []
          captured.calls.push(method)
        }
        if (method === 'listRacks') return [racks]
        if (method === 'pushAction') {
          if (captured) captured.payload = payload
          const arr = []
          if (errorHandler) errorHandler(pushResult, arr)
          return arr
        }
        return []
      }
    }
  }
}

test('getWorkOrderRackId - resolves the WO rack id from the ork rack registry', async (t) => {
  const captured = {}
  const id = await getWorkOrderRackId(buildCtx({ captured }))
  t.is(id, RACK_ID, 'returns the rack id carrying the work_order type')
  t.alike(captured.calls, ['listRacks'], 'asks the ork via listRacks')
})

test('getWorkOrderRackId - caches the resolved id and skips a second RPC', async (t) => {
  const captured = {}
  const ctx = buildCtx({ captured })
  await getWorkOrderRackId(ctx)
  const id = await getWorkOrderRackId(ctx)
  t.is(id, RACK_ID)
  t.is(ctx._workOrderRackId, RACK_ID, 'cached on ctx')
  t.alike(captured.calls, ['listRacks'], 'only one listRacks round-trip for repeated calls')
})

test('getWorkOrderRackId - returns the pre-set ctx cache without any RPC', async (t) => {
  const captured = {}
  const ctx = buildCtx({ captured })
  ctx._workOrderRackId = 'preset-rack'
  const id = await getWorkOrderRackId(ctx)
  t.is(id, 'preset-rack')
  t.is(captured.calls, undefined, 'no RPC issued when already cached')
})

test('getWorkOrderRackId - throws ERR_WORK_ORDER_RACK_NOT_FOUND when the ork has no WO rack', async (t) => {
  await t.exception(() => getWorkOrderRackId(buildCtx({ racks: [] })), /ERR_WORK_ORDER_RACK_NOT_FOUND/)
})

test('submitWorkOrderAction - submits pushAction against the resolved WO rack', async (t) => {
  const captured = {}
  const out = await submitWorkOrderAction(buildCtx({ captured }), woReq(), 'registerThing', { info: { foo: 'bar' } })

  t.alike(captured.calls, ['listRacks', 'pushAction'], 'resolves the rack then pushes')
  t.is(captured.payload.action, 'registerThing')
  t.is(captured.payload.query.rack, RACK_ID)
  t.is(captured.payload.params[0].rackId, RACK_ID)
  t.is(captured.payload.params[0].info.foo, 'bar')
  t.is(captured.payload.voter, 'op@test')
  t.alike(captured.payload.authPerms, ['inventory:rw', 'work_order:rw', 'actions:rw'])
  t.alike(out, [{ id: 'action-1', errors: [] }])
})

test('submitWorkOrderAction - elevateRackWrite appends the target rack write perm', async (t) => {
  const captured = {}
  await submitWorkOrderAction(
    buildCtx({ captured }), woReq(), 'updateThing',
    { id: 'miner-1', info: { status: 'ok_repaired' } },
    'miner-wm-m63spp-shelf-1',
    { elevateRackWrite: true }
  )
  t.alike(
    captured.payload.authPerms,
    ['inventory:rw', 'work_order:rw', 'actions:rw', 'miner:rw'],
    'miner rack write perm appended so the ork does not drop the target rack'
  )
})

test('submitWorkOrderAction - elevateRackWrite replaces a read-only entry for the same capability', async (t) => {
  const captured = {}
  await submitWorkOrderAction(
    buildCtx({ captured, perms: ['miner:r', 'inventory:rw', 'work_order:rw'] }), woReq(), 'updateThing',
    { id: 'miner-1', info: { status: 'ok_repaired' } },
    'miner-wm-m63spp-shelf-1',
    { elevateRackWrite: true }
  )
  t.alike(
    captured.payload.authPerms,
    ['inventory:rw', 'work_order:rw', 'miner:rw'],
    'miner:r is replaced, not shadowing the elevated entry for first-match consumers'
  )
})

test('submitWorkOrderAction - elevateRackWrite throws on a rack prefix that is not a permission', async (t) => {
  await t.exception(
    () => submitWorkOrderAction(
      buildCtx(), woReq(), 'updateThing', { id: 'x' }, 'bogus-rack-1', { elevateRackWrite: true }
    ),
    /ERR_WO_RACK_PERM_UNKNOWN:bogus/
  )
})

test('submitWorkOrderAction - elevateRackWrite does not duplicate a perm the caller has', async (t) => {
  const captured = {}
  await submitWorkOrderAction(
    buildCtx({ captured }), woReq(), 'updateThing',
    { id: 'part-1', info: { status: 'faulty' } },
    'inventory-miner_part-psu-shelf-1',
    { elevateRackWrite: true }
  )
  t.alike(captured.payload.authPerms, ['inventory:rw', 'work_order:rw', 'actions:rw'])
})

test('submitWorkOrderAction - no elevation without the opt-in', async (t) => {
  const captured = {}
  await submitWorkOrderAction(
    buildCtx({ captured }), woReq(), 'updateThing',
    { id: 'miner-1', info: { status: 'ok_repaired' } },
    'miner-wm-m63spp-shelf-1'
  )
  t.alike(captured.payload.authPerms, ['inventory:rw', 'work_order:rw', 'actions:rw'])
})

test('submitWorkOrderAction - maps an rpc error into the result array', async (t) => {
  const out = await submitWorkOrderAction(buildCtx({ pushResult: { error: 'boom' } }), woReq(), 'updateThing', { id: 'wo-1' })
  t.is(out[0].id, null)
  t.is(out[0].errors[0], 'boom')
})

test('submitWorkOrderAction - throws ERR_WORK_ORDER_RACK_NOT_FOUND when no WO rack exists', async (t) => {
  await t.exception(
    () => submitWorkOrderAction(buildCtx({ racks: [] }), woReq(), 'registerThing', {}),
    /ERR_WORK_ORDER_RACK_NOT_FOUND/
  )
})
