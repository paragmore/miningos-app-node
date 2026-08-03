'use strict'

const { flattenRpcResults } = require('../../utils')
const {
  WORK_ORDER_THING_TYPE,
  WORK_ORDER_TERMINAL_STATUSES,
  FILE_TYPES,
  WORK_ORDER_FILE_COUNT_CAP_DEFAULT,
  WORK_ORDER_FILE_MAX_BYTES_DEFAULT,
  WORK_ORDER_FILE_MIME_ALLOWLIST_DEFAULT
} = require('../../constants')
const { getWorkOrderRackId } = require('../lib/work.orders')
const { safeContentDispositionFilename } = require('../lib/queryUtils')

async function _loadWorkOrder (ctx, id) {
  const results = await ctx.dataProxy.requestData('listThings', {
    query: { id, type: WORK_ORDER_THING_TYPE }
  })
  return flattenRpcResults(results)[0] || null
}

async function _pushWorkOrderUpdate (ctx, req, info) {
  const rackId = await getWorkOrderRackId(ctx)
  const { permissions } = await ctx.authLib.getTokenPerms(req._info.authToken)
  return ctx.dataProxy.requestData('pushAction', {
    action: 'updateThing',
    query: { rack: rackId },
    params: [{ rackId, id: req.params.id, info }],
    voter: req._info.user.metadata.email,
    authPerms: permissions || []
  }, (res, arr) => {
    if (res?.error) arr.push({ id: null, errors: [res.error] })
    else arr.push(res)
  })
}

async function uploadWorkOrderFile (ctx, req) {
  const wo = await _loadWorkOrder(ctx, req.params.id)
  if (!wo) {
    const err = new Error('ERR_WORK_ORDER_NOT_FOUND')
    err.statusCode = 404
    throw err
  }
  if (WORK_ORDER_TERMINAL_STATUSES.includes(wo.info?.status)) {
    const err = new Error('ERR_WO_INVALID_STATUS_TRANSITION')
    err.statusCode = 400
    throw err
  }

  const cap = ctx.conf.workOrderFileCountCap || WORK_ORDER_FILE_COUNT_CAP_DEFAULT
  if ((wo.info?.files?.length || 0) >= cap) {
    const err = new Error('ERR_WO_FILE_COUNT_CAP_REACHED')
    err.statusCode = 400
    throw err
  }

  const part = await req.file()
  if (!part) {
    const err = new Error('ERR_FILE_REQUIRED')
    err.statusCode = 400
    throw err
  }

  const allowlist = new Set(ctx.conf.workOrderFileMimeAllowlist || WORK_ORDER_FILE_MIME_ALLOWLIST_DEFAULT)
  if (!allowlist.has(part.mimetype)) {
    const err = new Error('ERR_FILE_MIME_NOT_ALLOWED')
    err.statusCode = 400
    throw err
  }

  const buf = await part.toBuffer()
  const max = ctx.conf.workOrderFileMaxBytes || WORK_ORDER_FILE_MAX_BYTES_DEFAULT
  if (buf.length > max) {
    const err = new Error('ERR_FILE_TOO_LARGE')
    err.statusCode = 413
    throw err
  }

  const voter = req._info.user.metadata.email
  const rackId = await getWorkOrderRackId(ctx)
  const storeResults = await ctx.dataProxy.requestData('storeFile', {
    type: FILE_TYPES.WORK_ORDER,
    rackId,
    workOrderId: req.params.id,
    name: part.filename,
    mime: part.mimetype,
    contentBase64: buf.toString('base64'),
    user: voter
  })
  const meta = storeResults.find(r => r && r.id)
  if (!meta) {
    const failed = storeResults.find(r => r && r.error)
    throw new Error(failed?.error || 'ERR_WO_FILE_STORE_FAILED')
  }

  const files = [...(wo.info?.files || []), meta]
  await _pushWorkOrderUpdate(ctx, req, { files })

  return meta
}

async function downloadWorkOrderFile (ctx, req, rep) {
  const wo = await _loadWorkOrder(ctx, req.params.id)
  if (!wo) {
    const err = new Error('ERR_WORK_ORDER_NOT_FOUND')
    err.statusCode = 404
    throw err
  }
  const file = (wo.info?.files || []).find(f => f.id === req.params.fileId)
  if (!file) {
    const err = new Error('ERR_WO_FILE_NOT_FOUND')
    err.statusCode = 404
    throw err
  }

  const loaded = await ctx.dataProxy.requestData('loadFile', {
    type: FILE_TYPES.WORK_ORDER,
    rackId: await getWorkOrderRackId(ctx),
    workOrderId: wo.id,
    fileId: req.params.fileId
  })
  const got = loaded.find(r => r && r.contentBase64)
  if (!got) {
    const err = new Error('ERR_WO_FILE_NOT_FOUND')
    err.statusCode = 404
    throw err
  }

  rep.header('content-type', file.mime)
  rep.header('content-disposition', `attachment; filename="${safeContentDispositionFilename(file.name)}"`)
  rep.send(Buffer.from(got.contentBase64, 'base64'))
}

async function deleteWorkOrderFile (ctx, req) {
  const wo = await _loadWorkOrder(ctx, req.params.id)
  if (!wo) {
    const err = new Error('ERR_WORK_ORDER_NOT_FOUND')
    err.statusCode = 404
    throw err
  }
  if (WORK_ORDER_TERMINAL_STATUSES.includes(wo.info?.status)) {
    const err = new Error('ERR_WO_INVALID_STATUS_TRANSITION')
    err.statusCode = 400
    throw err
  }
  const files = wo.info?.files || []
  const file = files.find(f => f.id === req.params.fileId)
  if (!file) {
    const err = new Error('ERR_WO_FILE_NOT_FOUND')
    err.statusCode = 404
    throw err
  }

  const removeResults = await ctx.dataProxy.requestData('removeFile', {
    type: FILE_TYPES.WORK_ORDER,
    rackId: await getWorkOrderRackId(ctx),
    workOrderId: wo.id,
    fileId: req.params.fileId
  })
  await _pushWorkOrderUpdate(ctx, req, { files: files.filter(f => f.id !== req.params.fileId) })

  const removed = removeResults.find(r => r && typeof r.cleared === 'boolean')
  return { id: req.params.fileId, blobCleared: removed?.cleared ?? false }
}

module.exports = { uploadWorkOrderFile, downloadWorkOrderFile, deleteWorkOrderFile }
