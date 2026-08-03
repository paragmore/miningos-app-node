'use strict'

const { randomUUID } = require('crypto')
const { parseJsonQueryParam, flattenRpcResults, escapeRegex, listThingsWithCount } = require('../../utils')
const {
  WORK_ORDER_THING_TYPE,
  WORK_ORDER_TYPES,
  WORK_ORDER_TERMINAL_STATUSES,
  WORK_ORDER_VALID_DEVICE_TYPES,
  SPARE_PART_INITIAL_LOCATION
} = require('../../constants')
const { getWorkOrderRackId } = require('../lib/work.orders')

function _pushErrors (results) {
  return (results || []).flatMap(r => r?.errors || [])
}

async function _loadWorkOrder (ctx, workOrderId) {
  const results = await ctx.dataProxy.requestData('listThings', {
    query: { id: workOrderId, type: WORK_ORDER_THING_TYPE }
  })
  return flattenRpcResults(results)[0] || null
}

async function _loadSparePart (ctx, partId) {
  const results = await ctx.dataProxy.requestData('listThings', {
    query: { id: partId }
  })
  return flattenRpcResults(results).find(t => t?.type !== WORK_ORDER_THING_TYPE) || null
}

async function _loadSparePartByCode (ctx, code) {
  const results = await ctx.dataProxy.requestData('listThings', {
    query: { code }
  })
  return flattenRpcResults(results).find(t => t?.type !== WORK_ORDER_THING_TYPE) || null
}

async function updateSparePart (ctx, req) {
  const { id } = req.params
  const { rackId, workOrderId, info, remarks, replacesPartCode } = req.body

  const isReplacement = typeof replacesPartCode === 'string' && replacesPartCode.length > 0
  const movesPart = info.location !== undefined || info.status !== undefined || isReplacement

  if (movesPart && !workOrderId) {
    const err = new Error('ERR_PART_MOVE_REQUIRES_WO')
    err.statusCode = 400
    throw err
  }

  let workOrderCode
  let part
  let replacedPart
  if (movesPart) {
    const [wo, p, rp] = await Promise.all([
      _loadWorkOrder(ctx, workOrderId),
      _loadSparePart(ctx, id),
      isReplacement ? _loadSparePartByCode(ctx, replacesPartCode) : Promise.resolve(null)
    ])
    if (!wo) {
      const err = new Error('ERR_WORK_ORDER_NOT_FOUND')
      err.statusCode = 400
      throw err
    }
    if (WORK_ORDER_TERMINAL_STATUSES.includes(wo.info?.status)) {
      const err = new Error('ERR_WO_INVALID_STATUS_TRANSITION')
      err.statusCode = 400
      throw err
    }
    if (!p) {
      const err = new Error('ERR_SPARE_PART_NOT_FOUND')
      err.statusCode = 404
      throw err
    }
    if (isReplacement) {
      if (replacesPartCode === p.code) {
        const err = new Error('ERR_REPLACES_PART_SELF')
        err.statusCode = 400
        throw err
      }
      if (!rp) {
        const err = new Error('ERR_REPLACES_PART_NOT_FOUND')
        err.statusCode = 400
        throw err
      }
    }
    workOrderCode = wo.code
    part = p
    replacedPart = rp
  }

  const { permissions } = await ctx.authLib.getTokenPerms(req._info.authToken)
  const voter = req._info.user.metadata.email

  const partInfo = { ...info }
  if (movesPart) {
    partInfo.workOrderId = workOrderId
    partInfo.workOrderCode = workOrderCode
  }

  const partResults = await ctx.dataProxy.requestData('pushAction', {
    action: 'updateThing',
    query: { rack: rackId },
    params: [{ rackId, id, info: partInfo }],
    voter,
    authPerms: permissions || []
  }, (res, arr) => {
    if (res?.error) arr.push({ id: null, errors: [res.error] })
    else arr.push(res)
  })

  if (!movesPart) return partResults

  const partPushErrors = _pushErrors(partResults)
  if (partPushErrors.length) {
    const err = new Error(`ERR_PART_UPDATE_PUSH_FAILED:${partPushErrors.join(',')}`)
    err.statusCode = 502
    err.detail = { stage: 'part', partAction: null, workOrderAction: null }
    throw err
  }

  const moveRemarks = remarks ?? info.reason
  const moveEntry = {
    partId: id,
    partCode: part.code,
    workOrderId,
    workOrderCode,
    fromLocation: part.info?.location ?? null,
    toLocation: info.location ?? part.info?.location ?? null,
    fromStatus: part.info?.status ?? null,
    toStatus: info.status ?? part.info?.status ?? null,
    role: isReplacement ? 'replacement' : 'original',
    ts: Date.now(),
    user: voter
  }
  if (moveRemarks !== undefined && moveRemarks !== null) moveEntry.remarks = moveRemarks
  if (isReplacement) {
    moveEntry.replacesPartCode = replacesPartCode
    moveEntry.replacesPartId = replacedPart.id
  }

  const woRackId = await getWorkOrderRackId(ctx)
  const wo = await _loadWorkOrder(ctx, workOrderId)
  const currentMoves = Array.isArray(wo?.info?.partsMoves) ? wo.info.partsMoves : []

  const woResults = await ctx.dataProxy.requestData('pushAction', {
    action: 'updateThing',
    query: { rack: woRackId },
    params: [{ rackId: woRackId, id: workOrderId, info: { partsMoves: [...currentMoves, moveEntry] } }],
    voter,
    authPerms: permissions || []
  }, (res, arr) => {
    if (res?.error) arr.push({ id: null, errors: [res.error] })
    else arr.push(res)
  })

  return {
    part: partResults,
    workOrder: woResults,
    move: moveEntry,
    partActionId: partResults.find(r => r?.id)?.id ?? null,
    workOrderActionId: woResults.find(r => r?.id)?.id ?? null,
    workOrderAppendErrors: _pushErrors(woResults),
    expectedActionLatencyMs: ctx.conf?.expectedActionLatencyMs ?? 1000
  }
}

async function registerSparePart (ctx, req) {
  const { rackId, info } = req.body
  const deviceType = info.deviceType
  if (!WORK_ORDER_VALID_DEVICE_TYPES.includes(deviceType)) {
    const err = new Error('ERR_INVALID_DEVICE_TYPE')
    err.statusCode = 400
    throw err
  }
  if (!info.deviceModel || typeof info.deviceModel !== 'string') {
    const err = new Error('ERR_DEVICE_MODEL_REQUIRED')
    err.statusCode = 400
    throw err
  }
  if (!info.serialNum || typeof info.serialNum !== 'string') {
    const err = new Error('ERR_SERIAL_NUM_REQUIRED')
    err.statusCode = 400
    throw err
  }
  const workOrderRackId = await getWorkOrderRackId(ctx)

  const voter = req._info.user.metadata.email
  const { permissions } = await ctx.authLib.getTokenPerms(req._info.authToken)
  const authPerms = permissions || []

  const partId = randomUUID()
  const woId = randomUUID()
  const ts = Date.now()

  const partInfo = {
    ...info,
    location: info.location ?? SPARE_PART_INITIAL_LOCATION
  }
  const woInfo = {
    type: WORK_ORDER_TYPES.REGISTER,
    deviceType,
    deviceModel: info.deviceModel,
    deviceIdentifier: info.serialNum,
    createdBy: voter,
    createdAt: ts,
    ...(info.notes ? { notes: info.notes } : {}),
    partsMoves: [{
      partId,
      fromLocation: null,
      toLocation: SPARE_PART_INITIAL_LOCATION,
      role: 'register',
      ts,
      user: voter
    }]
  }

  const pushSingleAction = (rack, id, info, opts) => ctx.dataProxy.requestData('pushAction', {
    action: 'registerThing',
    query: { rack },
    params: [{ rackId: rack, id, info, ...(opts ? { opts } : {}) }],
    voter,
    authPerms
  }, (res, arr) => {
    if (res?.error) arr.push({ id: null, errors: [res.error] })
    else arr.push(res)
  })

  const [partResults, woResults] = await Promise.all([
    pushSingleAction(rackId, partId, partInfo, {}),
    pushSingleAction(workOrderRackId, woId, woInfo)
  ])

  return {
    partId,
    workOrderId: woId,
    partActionId: partResults.find(r => r?.id)?.id ?? null,
    workOrderActionId: woResults.find(r => r?.id)?.id ?? null,
    errors: [..._pushErrors(partResults), ..._pushErrors(woResults)],
    expectedActionLatencyMs: ctx.conf?.expectedActionLatencyMs ?? 1000
  }
}

// Batch sibling of registerSparePart: N parts + one shared Type-1 register WO, with an optional note.
async function registerSparePartsBatch (ctx, req) {
  const { rackId, parts, note } = req.body

  for (const part of parts) {
    if (!WORK_ORDER_VALID_DEVICE_TYPES.includes(part.deviceType)) {
      const err = new Error('ERR_INVALID_DEVICE_TYPE')
      err.statusCode = 400
      throw err
    }
    if (!part.deviceModel || typeof part.deviceModel !== 'string') {
      const err = new Error('ERR_DEVICE_MODEL_REQUIRED')
      err.statusCode = 400
      throw err
    }
    if (!part.serialNum || typeof part.serialNum !== 'string') {
      const err = new Error('ERR_SERIAL_NUM_REQUIRED')
      err.statusCode = 400
      throw err
    }
  }

  const workOrderRackId = await getWorkOrderRackId(ctx)
  const voter = req._info.user.metadata.email
  const { permissions } = await ctx.authLib.getTokenPerms(req._info.authToken)
  const authPerms = permissions || []
  const ts = Date.now()

  // Assign every part id up front so the single shared register WO can reference them all.
  const prepared = parts.map((part) => {
    const partInfo = {
      ...part,
      location: part.location ?? SPARE_PART_INITIAL_LOCATION
    }
    if (note) partInfo.notes = note
    return { partId: randomUUID(), part, partInfo }
  })

  const woId = randomUUID()
  const [summary] = prepared
  const woInfo = {
    type: WORK_ORDER_TYPES.REGISTER,
    deviceType: summary.part.deviceType,
    deviceModel: summary.part.deviceModel,
    deviceIdentifier: summary.part.serialNum,
    deviceCount: prepared.length,
    createdBy: voter,
    createdAt: ts,
    partsMoves: prepared.map(({ partId, part }) => ({
      partId,
      deviceType: part.deviceType,
      deviceModel: part.deviceModel,
      deviceIdentifier: part.serialNum,
      fromLocation: null,
      toLocation: SPARE_PART_INITIAL_LOCATION,
      role: 'register',
      ts,
      user: voter
    }))
  }
  if (note) woInfo.notes = note

  const pushSingleAction = (rack, id, info, opts) => ctx.dataProxy.requestData('pushAction', {
    action: 'registerThing',
    query: { rack },
    params: [{ rackId: rack, id, info, ...(opts ? { opts } : {}) }],
    voter,
    authPerms
  }, (res, arr) => {
    if (res?.error) arr.push({ id: null, errors: [res.error] })
    else arr.push(res)
  })

  const [woResults, ...partResultsList] = await Promise.all([
    pushSingleAction(workOrderRackId, woId, woInfo),
    ...prepared.map(({ partId, partInfo }) => pushSingleAction(rackId, partId, partInfo, {}))
  ])

  const partsOut = prepared.map(({ partId }, i) => ({
    partId,
    partActionId: partResultsList[i].find(r => r?.id)?.id ?? null
  }))

  return {
    parts: partsOut,
    workOrderId: woId,
    workOrderActionId: woResults.find(r => r?.id)?.id ?? null,
    errors: [..._pushErrors(woResults), ...partResultsList.flatMap(_pushErrors)],
    expectedActionLatencyMs: ctx.conf?.expectedActionLatencyMs ?? 1000
  }
}

function _buildSparePartQuery (qs) {
  const query = qs.query
    ? parseJsonQueryParam(qs.query, 'ERR_QUERY_INVALID_JSON')
    : {}
  if (!query.type) query.type = { $ne: WORK_ORDER_THING_TYPE }
  if (qs.location) query['info.location'] = qs.location
  if (qs.status) query['info.status'] = qs.status
  if (qs.q) {
    const escaped = escapeRegex(qs.q)
    query.$or = [
      { code: { $regex: escaped, $options: 'i' } },
      { 'info.serialNum': { $regex: escaped, $options: 'i' } },
      { 'info.macAddress': { $regex: escaped, $options: 'i' } }
    ]
  }
  return query
}

async function listSpareParts (ctx, req) {
  return listThingsWithCount(ctx, _buildSparePartQuery(req.query), {
    offset: req.query.offset ?? 0,
    limit: req.query.limit ?? 100,
    sort: req.query.sort && parseJsonQueryParam(req.query.sort, 'ERR_SORT_INVALID_JSON'),
    fields: req.query.fields && parseJsonQueryParam(req.query.fields, 'ERR_FIELDS_INVALID_JSON')
  })
}

async function getRepairHistory (ctx, req) {
  const offset = req.query.offset ?? 0
  const limit = req.query.limit ?? 100
  const partId = req.params.id

  const results = await ctx.dataProxy.requestData('listThings', {
    query: { type: WORK_ORDER_THING_TYPE, 'info.partsMoves.partId': partId }
  })
  const wos = flattenRpcResults(results)

  const rows = []
  for (const wo of wos) {
    for (const move of (wo.info?.partsMoves || [])) {
      if (move.partId !== partId) continue
      rows.push({ ...move, workOrderId: wo.id, workOrderCode: wo.code })
    }
  }
  rows.sort((a, b) => b.ts - a.ts)

  return {
    data: rows.slice(offset, offset + limit),
    totalCount: rows.length,
    offset,
    limit,
    hasMore: offset + limit < rows.length
  }
}

module.exports = { registerSparePart, registerSparePartsBatch, listSpareParts, updateSparePart, getRepairHistory }
