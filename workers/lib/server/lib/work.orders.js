'use strict'

const { setTimeout: sleep } = require('timers/promises')
const {
  WORK_ORDER_THING_TYPE,
  WORK_ORDER_ACTION_WAIT_ATTEMPTS,
  WORK_ORDER_ACTION_WAIT_MS
} = require('../../constants')
const { flattenRpcResults } = require('../../utils')

async function getWorkOrderRackId (ctx) {
  if (ctx._workOrderRackId) return ctx._workOrderRackId
  const results = await ctx.dataProxy.requestData('listRacks', {
    type: WORK_ORDER_THING_TYPE
  })
  const rack = flattenRpcResults(results)[0]
  if (!rack || !rack.id) throw new Error('ERR_WORK_ORDER_RACK_NOT_FOUND')
  ctx._workOrderRackId = rack.id
  return rack.id
}

async function submitWorkOrderAction (ctx, req, action, paramObj, rackId) {
  rackId = rackId || await getWorkOrderRackId(ctx)
  const { permissions } = await ctx.authLib.getTokenPerms(req._info.authToken)

  const results = await ctx.dataProxy.requestData('pushAction', {
    action,
    query: { rack: rackId },
    params: [{ rackId, ...paramObj }],
    voter: req._info.user.metadata.email,
    authPerms: permissions || []
  }, (res, arr) => {
    if (res?.error) arr.push({ id: null, errors: [res.error] })
    else arr.push(res)
  })

  const ids = results.map(r => r?.id).filter(id => id !== null && id !== undefined)
  if (ids.length) req._woActionIds = (req._woActionIds || []).concat(ids)

  return results
}

function assertActionApplied (results, errCode) {
  const errors = (results || []).flatMap(r => r?.errors || [])
  if (errors.length) {
    const err = new Error(`${errCode}:${errors.join(',')}`)
    err.statusCode = 502
    throw err
  }
}

async function _loadActions (ctx, ids) {
  return ctx.dataProxy.requestData('getActionsBatch', { ids }, (res, arr) => {
    if (Array.isArray(res)) arr.push(...res)
  })
}

async function assertActionsExecuted (ctx, req, errCode) {
  const ids = req._woActionIds || []
  if (!ids.length) return

  for (let attempt = 0; attempt < WORK_ORDER_ACTION_WAIT_ATTEMPTS; attempt++) {
    const entries = await _loadActions(ctx, ids)
    if (!entries.length) return

    const done = entries.filter(e => e?.type === 'done')
    if (done.length === entries.length) {
      const errors = done.flatMap(e => Object.values(e.action?.targets || {})
        .flatMap(target => (target.calls || []).map(call => call.error).filter(Boolean)))
      if (!errors.length) return
      const err = new Error(`${errCode}:${errors.join(',')}`)
      err.statusCode = 502
      throw err
    }

    await sleep(WORK_ORDER_ACTION_WAIT_MS)
  }
}

module.exports = { getWorkOrderRackId, submitWorkOrderAction, assertActionApplied, assertActionsExecuted }
