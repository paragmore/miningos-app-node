'use strict'

const { randomUUID } = require('crypto')
const { parseJsonQueryParam, flattenRpcResults, escapeRegex, listThingsWithCount } = require('../../utils')
const {
  WORK_ORDER_THING_TYPE,
  WORK_ORDER_TYPES,
  WORK_ORDER_TERMINAL_STATUSES,
  WORK_ORDER_VALID_DEVICE_TYPES,
  SPARE_PART_INITIAL_LOCATION,
  MINER_ROOM_LOCATION,
  MAINTENANCE_CONTAINER
} = require('../../constants')
const { renderWorkOrderCsv, renderRmaCsv } = require('../lib/work.order.export')
const { submitWorkOrderAction, getWorkOrderRackId, assertActionApplied, assertActionsExecuted } = require('../lib/work.orders')

async function _resolvePartByIdentifier (ctx, identifier) {
  const results = await ctx.dataProxy.requestData('listThings', {
    query: {
      $or: [
        { id: identifier },
        { code: identifier },
        { 'info.serialNum': identifier },
        { 'info.macAddress': identifier }
      ]
    }
  })
  return flattenRpcResults(results).find(t => t?.type !== WORK_ORDER_THING_TYPE) || null
}

function _badRequest (code) {
  const err = new Error(code)
  err.statusCode = 400
  return err
}

function _isMiner (thing) {
  const type = String(thing?.type || '')
  return type === 'miner' || type.startsWith('miner-')
}

function _occupiesSocket (thing) {
  const { container, pos } = thing?.info || {}
  return Boolean(container && container !== MAINTENANCE_CONTAINER && pos)
}

// A miner leaving the miner room gives up its socket: pos is cleared and the
// container parked at 'maintenance'. A miner entering the room must carry the
// group/socket picked in the UI (container + pos, subnet when the group has one).
function _minerPlacementInfo (deviceType, toLocation, placement = {}) {
  if (deviceType !== 'miner' || toLocation == null) return {}
  if (toLocation === MINER_ROOM_LOCATION) {
    const { pos, container, subnet } = placement
    if (!pos || !container) {
      const err = new Error('ERR_WO_MINER_ROOM_PLACEMENT_REQUIRED')
      err.statusCode = 400
      throw err
    }
    return { pos, container, ...(subnet ? { subnet } : {}) }
  }
  return { pos: '', container: MAINTENANCE_CONTAINER }
}

async function _resolveReplacement (ctx, { type, deviceType, part, toLocation, identifier, movingIds, usedIds }) {
  if (type !== WORK_ORDER_TYPES.MOVE) throw _badRequest('ERR_WO_REPLACEMENT_NOT_ALLOWED')
  if (deviceType !== 'miner') throw _badRequest('ERR_WO_REPLACEMENT_DEVICE_TYPE_INVALID')
  if (!toLocation || toLocation === MINER_ROOM_LOCATION) throw _badRequest('ERR_WO_REPLACEMENT_NOT_LEAVING_MINER_ROOM')

  const fromLocation = part.info?.location ?? null
  if (fromLocation !== null && fromLocation !== MINER_ROOM_LOCATION) {
    throw _badRequest('ERR_WO_REPLACEMENT_NOT_LEAVING_MINER_ROOM')
  }
  if (!_occupiesSocket(part)) throw _badRequest('ERR_WO_REPLACEMENT_POSITION_UNKNOWN')

  const replacement = await _resolvePartByIdentifier(ctx, identifier)
  if (!replacement) throw _badRequest('ERR_WO_REPLACEMENT_NOT_FOUND')
  if (!_isMiner(replacement)) throw _badRequest('ERR_WO_REPLACEMENT_DEVICE_TYPE_INVALID')
  if (movingIds.has(replacement.id)) throw _badRequest('ERR_WO_REPLACEMENT_IS_MOVING')
  if (usedIds.has(replacement.id)) throw _badRequest('ERR_WO_REPLACEMENT_DUPLICATE')
  if (replacement.info?.location === MINER_ROOM_LOCATION || _occupiesSocket(replacement)) {
    throw _badRequest('ERR_WO_REPLACEMENT_NOT_AVAILABLE')
  }
  usedIds.add(replacement.id)

  const { container, pos, subnet } = part.info || {}
  return { thing: replacement, identifier, vacated: { container, pos, subnet: subnet ?? null } }
}

function _replacementInfo (replacement, woId) {
  const { container, pos, subnet } = replacement.vacated
  return {
    location: MINER_ROOM_LOCATION,
    container,
    pos,
    ...(subnet ? { subnet } : {}),
    workOrderId: woId
  }
}

async function _moveAttachedParts (ctx, req, { miner, deviceType, toLocation, woId, voter, ts }) {
  if (deviceType !== 'miner' || toLocation == null) return []

  const results = await ctx.dataProxy.requestData('listThings', {
    query: { 'info.parentDeviceId': miner.id }
  })
  const parts = flattenRpcResults(results).filter(t => t?.type !== WORK_ORDER_THING_TYPE)

  const moves = []
  for (const part of parts) {
    const partResults = await submitWorkOrderAction(ctx, req, 'updateThing', {
      id: part.id,
      info: { location: toLocation, workOrderId: woId }
    }, part.rack)
    assertActionApplied(partResults, `ERR_ATTACHED_PART_MOVE_PUSH_FAILED:${part.id}`)
    moves.push({
      partId: part.id,
      partCode: part.code,
      parentDeviceId: miner.id,
      parentDeviceCode: miner.code,
      role: 'attached',
      fromLocation: part.info?.location ?? null,
      toLocation,
      ts,
      user: voter
    })
  }
  return moves
}

function _buildReplacementMove (replacement, part, voter, ts) {
  const { thing, vacated } = replacement
  return {
    partId: thing.id,
    partCode: thing.code,
    deviceType: 'miner',
    deviceModel: thing.type ?? null,
    deviceIdentifier: replacement.identifier,
    role: 'replacement',
    replacesPartId: part.id,
    replacesPartCode: part.code,
    fromLocation: thing.info?.location ?? null,
    toLocation: MINER_ROOM_LOCATION,
    fromContainer: thing.info?.container ?? null,
    fromPos: thing.info?.pos ?? null,
    toContainer: vacated.container,
    toPos: vacated.pos,
    ts,
    user: voter
  }
}

async function createWorkOrder (ctx, req) {
  const { type, deviceType, deviceIdentifier } = req.body

  if (!WORK_ORDER_VALID_DEVICE_TYPES.includes(deviceType)) {
    const err = new Error('ERR_INVALID_DEVICE_TYPE')
    err.statusCode = 400
    throw err
  }

  const voter = req._info.user.metadata.email
  const woId = randomUUID()
  const { info: extraInfo, ...body } = req.body
  const info = { ...body, ...extraInfo, createdBy: voter, createdAt: Date.now() }

  if (type === WORK_ORDER_TYPES.MICROBT_MINER || type === WORK_ORDER_TYPES.MICROBT_NON_MINER) {
    const part = await _resolvePartByIdentifier(ctx, deviceIdentifier)
    if (!part) {
      const err = new Error('ERR_PART_NOT_FOUND')
      err.statusCode = 400
      throw err
    }
    info.partsMoves = [{
      partId: part.id,
      partCode: part.code,
      role: 'diagnosis',
      ...(info.deviceStatus
        ? { fromStatus: part.info?.status ?? null, toStatus: info.deviceStatus }
        : {}),
      ts: Date.now(),
      user: voter
    }]
    if (info.deviceStatus) {
      const partResults = await submitWorkOrderAction(ctx, req, 'updateThing', { id: part.id, info: { status: info.deviceStatus, workOrderId: woId } }, part.rack)
      assertActionApplied(partResults, 'ERR_PART_MOVE_PUSH_FAILED')
    }
  } else if (type === WORK_ORDER_TYPES.REGISTER) {
    const part = await _resolvePartByIdentifier(ctx, deviceIdentifier)
    if (!part) {
      const err = new Error('ERR_PART_NOT_FOUND')
      err.statusCode = 400
      throw err
    }
    info.partsMoves = [{
      partId: part.id,
      partCode: part.code,
      fromLocation: null,
      toLocation: SPARE_PART_INITIAL_LOCATION,
      role: 'register',
      ts: Date.now(),
      user: voter
    }]
  } else if (type === WORK_ORDER_TYPES.MOVE) {
    const part = await _resolvePartByIdentifier(ctx, deviceIdentifier)
    if (!part) {
      const err = new Error('ERR_PART_NOT_FOUND')
      err.statusCode = 400
      throw err
    }
    const placement = info.location != null ? _minerPlacementInfo(deviceType, info.location, info) : {}
    const replacement = info.replacementIdentifier
      ? await _resolveReplacement(ctx, {
        type,
        deviceType,
        part,
        toLocation: info.location,
        identifier: info.replacementIdentifier,
        movingIds: new Set([part.id]),
        usedIds: new Set()
      })
      : null
    const ts = Date.now()
    info.partsMoves = [{
      partId: part.id,
      partCode: part.code,
      fromLocation: part.info?.location ?? null,
      toLocation: info.location ?? null,
      fromStatus: part.info?.status ?? null,
      toStatus: info.deviceStatus ?? null,
      ...(deviceType === 'miner'
        ? {
            fromContainer: part.info?.container ?? null,
            fromPos: part.info?.pos ?? null,
            toContainer: placement.container ?? null,
            toPos: placement.pos ?? null
          }
        : {}),
      role: 'move',
      ts,
      user: voter
    }]
    // Move WOs auto-close, so the relocation has to happen here or it never will.
    // The part rack rejects a location change that omits workOrderId (ERR_PART_MOVE_REQUIRES_WO).
    if (info.location != null) {
      const partResults = await submitWorkOrderAction(ctx, req, 'updateThing', {
        id: part.id,
        info: {
          location: info.location,
          workOrderId: woId,
          ...(info.deviceStatus ? { status: info.deviceStatus } : {}),
          ...placement
        }
      }, part.rack)
      assertActionApplied(partResults, 'ERR_PART_MOVE_PUSH_FAILED')
      info.partsMoves.push(...await _moveAttachedParts(ctx, req, {
        miner: part, deviceType, toLocation: info.location, woId, voter, ts
      }))
    }
    if (replacement) {
      info.partsMoves.push(_buildReplacementMove(replacement, part, voter, ts))
      const replacementResults = await submitWorkOrderAction(ctx, req, 'updateThing', {
        id: replacement.thing.id,
        info: _replacementInfo(replacement, woId)
      }, replacement.thing.rack)
      assertActionApplied(replacementResults, 'ERR_WO_REPLACEMENT_PUSH_FAILED')
    }
  }

  await assertActionsExecuted(ctx, req, 'ERR_WO_DEVICE_UPDATE_FAILED')

  return submitWorkOrderAction(ctx, req, 'registerThing', { id: woId, info })
}

function _buildPartsMove (type, part, device, info, voter, ts, placement = {}) {
  const base = {
    partId: part.id,
    partCode: part.code,
    deviceType: device.deviceType,
    deviceModel: device.deviceModel,
    deviceIdentifier: device.deviceIdentifier,
    ts,
    user: voter
  }
  if (type === WORK_ORDER_TYPES.MICROBT_MINER || type === WORK_ORDER_TYPES.MICROBT_NON_MINER) {
    return { ...base, role: 'diagnosis' }
  }
  if (type === WORK_ORDER_TYPES.REGISTER) {
    return { ...base, role: 'register', fromLocation: null, toLocation: SPARE_PART_INITIAL_LOCATION }
  }
  if (type === WORK_ORDER_TYPES.MOVE) {
    return {
      ...base,
      role: 'move',
      fromLocation: part.info?.location ?? null,
      toLocation: info.location ?? null,
      fromStatus: part.info?.status ?? null,
      toStatus: info.deviceStatus ?? null,
      ...(device.deviceType === 'miner'
        ? {
            fromContainer: part.info?.container ?? null,
            fromPos: part.info?.pos ?? null,
            toContainer: placement.container ?? null,
            toPos: placement.pos ?? null
          }
        : {})
    }
  }
  return null
}

// Batch sibling of createWorkOrder: one work order whose partsMoves carries every device.
async function createWorkOrdersBatch (ctx, req) {
  const { type, devices, info: extraInfo, ...rest } = req.body

  for (const device of devices) {
    if (!WORK_ORDER_VALID_DEVICE_TYPES.includes(device.deviceType)) {
      const err = new Error('ERR_INVALID_DEVICE_TYPE')
      err.statusCode = 400
      throw err
    }
  }

  const voter = req._info.user.metadata.email
  const woId = randomUUID()
  const ts = Date.now()

  // A MicroBT repair is about the miner, and `devices` carries the spare parts
  // swapped into it — so devices[0] is a part, not the subject. The rack still
  // demands root device* fields, so they come from info.minerIdentifier here and
  // the parts stay confined to partsMoves.
  const isMinerRepair = type === WORK_ORDER_TYPES.MICROBT_MINER
  const hasRepairMinerIdentifier = isMinerRepair && Boolean(extraInfo?.minerIdentifier)
  const minerToRepair = hasRepairMinerIdentifier
    ? await _resolvePartByIdentifier(ctx, extraInfo.minerIdentifier)
    : null
  if (hasRepairMinerIdentifier && !minerToRepair) throw _badRequest('ERR_PART_NOT_FOUND')

  // Everywhere else a batch is homogeneous, so the first device is the summary
  // used by the thing-side validator, RMA export, and single-device views.
  const summary = minerToRepair
    ? {
        deviceType: 'miner',
        deviceModel: minerToRepair.type ?? devices[0].deviceModel,
        deviceIdentifier: minerToRepair.info?.serialNum ?? minerToRepair.code ?? extraInfo.minerIdentifier
      }
    : devices[0]

  const info = {
    type,
    ...rest,
    ...extraInfo,
    deviceType: summary.deviceType,
    deviceModel: summary.deviceModel,
    deviceIdentifier: summary.deviceIdentifier,
    deviceCount: devices.length,
    createdBy: voter,
    createdAt: ts
  }

  const resolved = []
  for (const device of devices) {
    const part = await _resolvePartByIdentifier(ctx, device.deviceIdentifier)
    if (!part) {
      const err = new Error('ERR_PART_NOT_FOUND')
      err.statusCode = 400
      throw err
    }
    resolved.push({ device, part })
  }

  const movingIds = new Set(resolved.map(r => r.part.id))
  const usedIds = new Set()
  for (const entry of resolved) {
    if (!entry.device.replacementIdentifier) continue
    entry.replacement = await _resolveReplacement(ctx, {
      type,
      deviceType: entry.device.deviceType,
      part: entry.part,
      toLocation: info.location,
      identifier: entry.device.replacementIdentifier,
      movingIds,
      usedIds
    })
  }

  const partsMoves = []
  for (const { device, part, replacement } of resolved) {
    const placement = type === WORK_ORDER_TYPES.MOVE && info.location != null
      ? _minerPlacementInfo(device.deviceType, info.location, device)
      : {}
    const move = _buildPartsMove(type, part, device, info, voter, ts, placement)
    if (move) partsMoves.push(move)
    // Move WOs auto-close, so relocate each part here or it never happens.
    // The part rack rejects a location change that omits workOrderId (ERR_PART_MOVE_REQUIRES_WO).
    if (type === WORK_ORDER_TYPES.MOVE && info.location != null) {
      const partResults = await submitWorkOrderAction(ctx, req, 'updateThing', {
        id: part.id,
        info: {
          location: info.location,
          workOrderId: woId,
          ...(info.deviceStatus ? { status: info.deviceStatus } : {}),
          ...placement
        }
      }, part.rack)
      assertActionApplied(partResults, 'ERR_PART_MOVE_PUSH_FAILED')
      partsMoves.push(...await _moveAttachedParts(ctx, req, {
        miner: part, deviceType: device.deviceType, toLocation: info.location, woId, voter, ts
      }))
    }
    if (replacement) {
      partsMoves.push(_buildReplacementMove(replacement, part, voter, ts))
      const replacementResults = await submitWorkOrderAction(ctx, req, 'updateThing', {
        id: replacement.thing.id,
        info: _replacementInfo(replacement, woId)
      }, replacement.thing.rack)
      assertActionApplied(replacementResults, 'ERR_WO_REPLACEMENT_PUSH_FAILED')
    }
  }

  // MicroBT repair WOs list only the repaired parts as devices; the miner
  // itself rides in info.minerIdentifier, so its status change lands here.
  if (minerToRepair && info.deviceStatus) {
    partsMoves.push({
      partId: minerToRepair.id,
      partCode: minerToRepair.code,
      role: 'status_change',
      fromStatus: minerToRepair.info?.status ?? null,
      toStatus: info.deviceStatus,
      ts,
      user: voter
    })
    const minerResults = await submitWorkOrderAction(ctx, req, 'updateThing', { id: minerToRepair.id, info: { status: info.deviceStatus, workOrderId: woId } }, minerToRepair.rack)
    assertActionApplied(minerResults, 'ERR_PART_MOVE_PUSH_FAILED')
  }

  info.partsMoves = partsMoves

  await assertActionsExecuted(ctx, req, 'ERR_WO_DEVICE_UPDATE_FAILED')

  return submitWorkOrderAction(ctx, req, 'registerThing', { id: woId, info })
}

async function updateWorkOrder (ctx, req) {
  const { info: extraInfo, ...body } = req.body
  return submitWorkOrderAction(ctx, req, 'updateThing', { id: req.params.id, info: { ...body, ...extraInfo } })
}

async function closeWorkOrder (ctx, req) {
  const info = { status: 'closed', closedAt: Date.now() }
  if (req.body?.finalResult) info.finalResult = req.body.finalResult
  return submitWorkOrderAction(ctx, req, 'updateThing', { id: req.params.id, info })
}

async function cancelWorkOrder (ctx, req) {
  const info = { status: 'cancelled' }
  if (req.body?.reason) info.cancelReason = req.body.reason
  return submitWorkOrderAction(ctx, req, 'updateThing', { id: req.params.id, info })
}

async function reopenWorkOrder (ctx, req) {
  const info = { status: 'open', closedAt: null }
  if (req.body?.reason) info.reopenReason = req.body.reason
  return submitWorkOrderAction(ctx, req, 'updateThing', { id: req.params.id, info })
}

async function assignWorkOrder (ctx, req) {
  return submitWorkOrderAction(ctx, req, 'updateThing', {
    id: req.params.id,
    info: { assignedTo: req.body.assignedTo }
  })
}

function _buildWorkOrderQuery (qs) {
  const query = qs.query
    ? parseJsonQueryParam(qs.query, 'ERR_QUERY_INVALID_JSON')
    : {}
  query.type = WORK_ORDER_THING_TYPE
  if (qs.assignee) query['info.assignedTo'] = qs.assignee
  if (qs.creator) query['info.createdBy'] = qs.creator
  if (qs.partId) query['info.partsMoves.partCode'] = qs.partId
  if (qs.status) query['info.status'] = qs.status
  if (qs.type != null) query['info.type'] = qs.type
  if (qs.from || qs.to) {
    query['info.createdAt'] = {}
    if (qs.from) query['info.createdAt'].$gte = qs.from
    if (qs.to) query['info.createdAt'].$lte = qs.to
  }
  if (qs.q) {
    const escaped = escapeRegex(qs.q)
    query.$or = [
      { code: { $regex: escaped } },
      { 'info.issue': { $regex: escaped, $options: 'i' } },
      { 'info.createdBy': { $regex: escaped, $options: 'i' } },
      { 'info.assignedTo': { $regex: escaped, $options: 'i' } }
    ]
  }
  return query
}

async function listWorkOrders (ctx, req) {
  return listThingsWithCount(ctx, _buildWorkOrderQuery(req.query), {
    offset: req.query.offset ?? 0,
    limit: req.query.limit ?? 100,
    sort: req.query.sort && parseJsonQueryParam(req.query.sort, 'ERR_SORT_INVALID_JSON'),
    fields: req.query.fields && parseJsonQueryParam(req.query.fields, 'ERR_FIELDS_INVALID_JSON')
  })
}

async function getWorkOrder (ctx, req) {
  const params = { query: { id: req.params.id, type: WORK_ORDER_THING_TYPE } }
  const results = await ctx.dataProxy.requestData('listThings', params)
  const flat = flattenRpcResults(results)
  if (!flat.length) {
    const err = new Error('ERR_WORK_ORDER_NOT_FOUND')
    err.statusCode = 404
    throw err
  }
  return flat[0]
}

async function appendWorkLogEntry (ctx, req) {
  const rackId = await getWorkOrderRackId(ctx)

  const wo = await ctx.dataProxy.requestData('listThings', {
    query: { id: req.params.id, type: WORK_ORDER_THING_TYPE }
  })
  const found = flattenRpcResults(wo)[0]
  if (!found) {
    const err = new Error('ERR_WORK_ORDER_NOT_FOUND')
    err.statusCode = 404
    throw err
  }
  if (WORK_ORDER_TERMINAL_STATUSES.includes(found.info?.status)) {
    const err = new Error('ERR_WO_INVALID_STATUS_TRANSITION')
    err.statusCode = 400
    throw err
  }

  return ctx.dataProxy.requestData('saveThingComment', {
    rackId,
    thingId: req.params.id,
    comment: req.body.text,
    user: req._info.user.metadata.email
  }, (res, arr) => {
    if (res?.error) arr.push({ error: res.error })
    else arr.push(res)
  })
}

async function _loadWorkOrderByIdOrCode (ctx, idOrCode) {
  const params = {
    query: {
      type: WORK_ORDER_THING_TYPE,
      $or: [{ id: idOrCode }, { code: idOrCode }]
    }
  }
  const results = await ctx.dataProxy.requestData('listThings', params)
  return flattenRpcResults(results)[0] || null
}

async function exportWorkOrder (ctx, req, rep) {
  const { format } = req.query
  if (format !== 'csv') {
    return rep.status(501).send({
      statusCode: 501,
      error: 'Not Implemented',
      message: `ERR_EXPORT_FORMAT_NOT_IMPLEMENTED:${format}`
    })
  }

  const wo = await _loadWorkOrderByIdOrCode(ctx, req.params.id)
  if (!wo) {
    const err = new Error('ERR_WORK_ORDER_NOT_FOUND')
    err.statusCode = 404
    throw err
  }

  const filename = wo.code || wo.id
  rep.header('content-type', 'text/csv; charset=utf-8')
  rep.header('content-disposition', `attachment; filename="${filename}.csv"`)
  return rep.send(renderWorkOrderCsv(wo))
}

async function exportWorkOrdersRma (ctx, req, rep) {
  const ids = req.query.ids.split(',').map(s => s.trim()).filter(Boolean)
  const params = {
    query: {
      type: WORK_ORDER_THING_TYPE,
      $or: [{ id: { $in: ids } }, { code: { $in: ids } }]
    }
  }
  const results = await ctx.dataProxy.requestData('listThings', params)
  const wos = flattenRpcResults(results).filter(wo => wo?.info?.type === WORK_ORDER_TYPES.MICROBT_MINER)

  rep.header('content-type', 'text/csv; charset=utf-8')
  rep.header('content-disposition', 'attachment; filename="rma.csv"')
  return rep.send(renderRmaCsv(wos))
}

async function getWorkOrderAudit (ctx, req) {
  const payload = {
    logType: 'info',
    limit: req.query.limit ?? 100,
    offset: req.query.offset ?? 0,
    start: req.query.start,
    end: req.query.end,
    query: { 'thing.id': req.params.id }
  }
  const results = await ctx.dataProxy.requestData('getHistoricalLogs', payload)
  return flattenRpcResults(results)
}

module.exports = {
  createWorkOrder,
  createWorkOrdersBatch,
  listWorkOrders,
  getWorkOrder,
  updateWorkOrder,
  closeWorkOrder,
  cancelWorkOrder,
  reopenWorkOrder,
  assignWorkOrder,
  appendWorkLogEntry,
  getWorkOrderAudit,
  exportWorkOrder,
  exportWorkOrdersRma
}
