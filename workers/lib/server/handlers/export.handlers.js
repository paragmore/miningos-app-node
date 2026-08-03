'use strict'

const { getExportType, resolveExport } = require('../lib/export/registry')
const { capCheck } = require('../lib/capCheck')
const { safeContentDispositionFilename } = require('../lib/queryUtils')

const PARAM_ERRORS = new Set([
  'ERR_EXPORT_CONTAINER_REQUIRED',
  'ERR_EXPORT_STAT_KEY_REQUIRED',
  'ERR_EXPORT_RANGE_REQUIRED',
  'ERR_EXPORT_RANGE_INVALID',
  'ERR_EXPORT_TIMEZONE_INVALID'
])

async function exportRoute (ctx, req, reply) {
  const entry = getExportType(req.query.type)
  if (!entry) {
    return reply.code(400).send({ error: 'ERR_EXPORT_TYPE_UNKNOWN' })
  }

  if (entry.perms && !ctx.noAuth) {
    const denied = await capCheck(ctx, req, reply, entry.perms, false)
    if (denied !== undefined) return denied
  }

  try {
    entry.assertParams(req.query)
  } catch (err) {
    return reply.code(400).send({ error: err.message })
  }

  let exportFile
  try {
    exportFile = await resolveExport(ctx, entry, req.query)
  } catch (err) {
    if (err.message === 'ERR_EXPORT_NO_DATA') {
      return reply.code(404).send({ error: err.message })
    }
    if (PARAM_ERRORS.has(err.message)) {
      return reply.code(400).send({ error: err.message })
    }
    throw err
  }

  reply.header('content-type', exportFile.contentType)
  reply.header('content-disposition',
    `attachment; filename="${safeContentDispositionFilename(exportFile.filename)}"`)
  reply.header('cache-control', 'no-store')

  return reply.send(exportFile.stream)
}

module.exports = {
  exportRoute
}
