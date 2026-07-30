'use strict'

const { downloadLogFile } = require('./actions.handlers')

// Worker error code prefixes -> human-readable messages (raw code stays in `error`)
const WORKER_ERROR_MESSAGES = [
  ['ERR_DOWNLOAD_LOGS_PARSE_FAILED', 'The miner sent a malformed response header; the download was aborted'],
  ['ERR_DOWNLOAD_LOGS_FAILED', 'The miner rejected the download-logs command'],
  ['ERR_DOWNLOAD_LOGS_EMPTY', 'The miner reports an empty log archive — there is nothing to download'],
  ['ERR_DOWNLOAD_LOGS_TIMEOUT', 'The miner did not deliver the log within the time limit'],
  ['ERR_DOWNLOAD_LOGS_INCOMPLETE', 'The connection to the miner dropped before the full log was transferred'],
  ['ERR_DOWNLOAD_LOGS_CONNECT_FAILED', 'Could not connect to the miner to download logs'],
  ['ERR_LOG_CORE_MANAGER_NOT_READY', 'The rack worker is not ready to serve log transfers yet'],
  ['ERR_LOG_NOT_AVAILABLE', 'The action completed but produced no downloadable log']
]

function describeWorkerError (errorCode) {
  const match = WORKER_ERROR_MESSAGES.find(([prefix]) => errorCode.startsWith(prefix))
  return match ? match[1] : 'The download-logs action failed on the rack worker'
}

/**
 * Miner log download — three-step REST flow for large async file transfers:
 *
 *   1. POST /auth/miners/:minerId/download-logs
 *      Submits a downloadLogs action for the miner.
 *      Returns 202 Accepted immediately with { jobId }.
 *
 *   2. GET /auth/miners/:minerId/download-logs/:jobId/status
 *      Polls whether the action has completed.
 *      Returns { status: 'pending' | 'ready' | 'failed' | 'expired', ... }.
 *
 *   3. GET /auth/miners/:minerId/download-logs/:jobId/file
 *      Streams the binary log file once status is 'ready'.
 *      Uses the Hypercore P2P pipeline — no buffering.
 */

async function startMinerLogDownload (ctx, req, reply) {
  const { minerId } = req.params

  const { write, permissions } = await ctx.authLib.getTokenPerms(req._info.authToken)
  if (!write) {
    return reply.code(403).send({ error: 'ERR_WRITE_PERM_REQUIRED' })
  }

  const payload = {
    query: { id: minerId },
    action: 'downloadLogs',
    params: [],
    voter: req._info.user.metadata.email,
    authPerms: permissions
  }

  let results
  try {
    results = await ctx.dataProxy.requestData('pushAction', payload, (res, arr) => {
      if (res.error) {
        arr.push({ id: null, errors: [res.error] })
      } else {
        arr.push(res)
      }
    })
  } catch (err) {
    return reply.code(500).send({ error: err.message })
  }

  const result = Array.isArray(results)
    ? results.find(r => r && r.id !== null && r.id !== undefined)
    : results

  if (!result || result.id == null) {
    const errMsg = (Array.isArray(results) ? results[0]?.errors?.[0] : null) || 'ERR_ACTION_SUBMIT_FAILED'
    return reply.code(400).send({ error: errMsg })
  }

  const jobId = String(result.id)

  return reply.code(202).send({
    jobId,
    statusUrl: `/auth/miners/${encodeURIComponent(minerId)}/download-logs/${jobId}/status`,
    fileUrl: `/auth/miners/${encodeURIComponent(minerId)}/download-logs/${jobId}/file`
  })
}

/**
 * GET /auth/miners/:minerId/download-logs/:jobId/status
 *
 * Polls the action result to determine whether the log is ready to download.
 *
 * Status values:
 *   pending  — action not yet completed (still in voting/executing pipeline)
 *   ready    — Hypercore is serving the log; use fileUrl to download
 *   failed   — action completed but the miner returned an error
 *   expired  — log was ready but the Hypercore TTL has passed
 */
function assertJobOwner (action, req) {
  const email = req._info?.user?.metadata?.email
  return !!(email && action.voter && action.voter === email)
}

async function getMinerLogDownloadStatus (ctx, req, reply) {
  const { minerId, jobId } = req.params

  let action = null
  try {
    const results = await ctx.dataProxy.requestData('getAction', { id: jobId, type: 'done' })
    action = Array.isArray(results) ? results.find(r => r && !r.error) : results
  } catch (err) {
    return reply.code(500).send({ error: err.message })
  }

  // Action not yet in the 'done' bucket — still executing through the pipeline
  if (!action || !action.targets) {
    return reply.code(200).send({ status: 'pending', jobId })
  }

  if (!assertJobOwner(action, req)) {
    return reply.code(403).send({ error: 'ERR_AUTH_FAIL_NO_PERMS' })
  }

  let meta = null
  let firstError = null

  for (const rack of Object.values(action.targets)) {
    for (const call of (rack.calls || [])) {
      if (call.result?.success && call.result?.data?.coreKey) {
        meta = call.result.data
        break
      }
      if (!firstError && call.result?.error_msg) {
        firstError = call.result.error_msg
      }
    }
    if (meta) break
  }

  if (!meta) {
    const error = firstError || 'ERR_LOG_NOT_AVAILABLE'
    return reply.code(200).send({
      status: 'failed',
      jobId,
      error,
      message: describeWorkerError(error)
    })
  }

  if (meta.minerId && meta.minerId !== minerId) {
    return reply.code(404).send({ error: 'ERR_ACTION_NOT_FOUND' })
  }

  if (meta.expiresAt && Date.now() > meta.expiresAt) {
    return reply.code(200).send({
      status: 'expired',
      jobId,
      error: 'ERR_LOG_EXPIRED'
    })
  }

  return reply.code(200).send({
    status: 'ready',
    jobId,
    minerId: meta.minerId || minerId,
    byteLength: meta.byteLength,
    expiresAt: meta.expiresAt,
    fileUrl: `/auth/miners/${encodeURIComponent(minerId)}/download-logs/${jobId}/file`
  })
}

function getMinerLogFile (ctx, req, reply) {
  // downloadLogFile expects req.params.id — bridge from our :jobId param
  return downloadLogFile(ctx, { ...req, params: { ...req.params, id: req.params.jobId } }, reply)
}

module.exports = {
  startMinerLogDownload,
  getMinerLogDownloadStatus,
  getMinerLogFile
}
