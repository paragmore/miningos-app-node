'use strict'

const { WORK_ORDER_THING_TYPE } = require('../../constants')
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

  return ctx.dataProxy.requestData('pushAction', {
    action,
    query: { rack: rackId },
    params: [{ rackId, ...paramObj }],
    voter: req._info.user.metadata.email,
    authPerms: permissions || []
  }, (res, arr) => {
    if (res?.error) arr.push({ id: null, errors: [res.error] })
    else arr.push(res)
  })
}

function assertActionApplied (results, errCode) {
  const errors = (results || []).flatMap(r => r?.errors || [])
  if (errors.length) {
    const err = new Error(`${errCode}:${errors.join(',')}`)
    err.statusCode = 502
    throw err
  }
}

module.exports = { getWorkOrderRackId, submitWorkOrderAction, assertActionApplied }
