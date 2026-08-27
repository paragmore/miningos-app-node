'use strict'

const zlib = require('zlib')
const { Readable } = require('streamx')
const test = require('brittle')
const {
  startMinerLogDownload,
  getMinerLogDownloadStatus,
  getMinerLogFile
} = require('../../../workers/lib/server/handlers/minerLogs.handlers')

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMockReply () {
  let _code = 200
  let _body = null
  const _headers = {}
  const reply = {
    get statusCode () { return _code },
    get body () { return _body },
    get headers () { return _headers },
    code (statusCode) {
      _code = statusCode
      return reply
    },
    header (name, value) {
      _headers[name.toLowerCase()] = value
      return reply
    },
    send (body) {
      _body = body
      return body
    }
  }
  return reply
}

function makeMockReq (minerId = 'miner-001', jobId = null, token = 'test-token') {
  const req = {
    params: { minerId },
    _info: {
      authToken: token,
      user: { metadata: { email: 'ops@example.com' } }
    }
  }
  if (jobId !== null) req.params.jobId = jobId
  return req
}

function makeMockCtx ({ write = true, permissions = ['admin'], requestDataResult = null } = {}) {
  return {
    authLib: {
      getTokenPerms: async () => ({ write, permissions })
    },
    dataProxy: {
      requestData: async (method, payload, callback) => {
        if (requestDataResult === null) return []
        if (typeof callback === 'function') {
          const arr = []
          const items = Array.isArray(requestDataResult) ? requestDataResult : [requestDataResult]
          for (const item of items) callback(item, arr)
          return arr
        }
        return Array.isArray(requestDataResult) ? requestDataResult : [requestDataResult]
      }
    }
  }
}

// Mirrors the real ork `getAction` record: the submitter is votesPos[0]
// (svc-facs-action-approver pushAction) — there is no `voter` field.
function makeActionResult (overrides = {}) {
  return {
    votesPos: ['ops@example.com'],
    targets: {
      'rack-001': {
        calls: [
          {
            result: {
              success: true,
              data: {
                coreKey: 'a'.repeat(64),
                byteLength: 1024,
                expiresAt: Date.now() + 3600000,
                minerId: 'miner-001',
                ...overrides.data
              }
            }
          }
        ]
      }
    },
    ...overrides
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// startMinerLogDownload
// ─────────────────────────────────────────────────────────────────────────────

test('startMinerLogDownload - returns 202 with jobId on success', async (t) => {
  const ctx = makeMockCtx({ requestDataResult: { id: '12345' } })
  const req = makeMockReq('miner-001')
  const reply = makeMockReply()

  await startMinerLogDownload(ctx, req, reply)

  t.is(reply.statusCode, 202, 'should return 202 Accepted')
  t.is(reply.body.jobId, '12345', 'should include jobId')
  t.ok(reply.body.statusUrl.includes('/status'), 'should include statusUrl')
  t.ok(reply.body.fileUrl.includes('/file'), 'should include fileUrl')
  t.ok(reply.body.statusUrl.includes('miner-001'), 'statusUrl should include minerId')
  t.ok(reply.body.fileUrl.includes('miner-001'), 'fileUrl should include minerId')
  t.pass()
})

test('startMinerLogDownload - accepts a read-only token', async (t) => {
  // A log download is a read: `getTokenPerms().write` is just `actions:w`, so a
  // read-only user must not be turned away here. The route enforces `miner:r`.
  const ctx = makeMockCtx({
    write: false,
    permissions: ['miner:r'],
    requestDataResult: { id: '12345' }
  })
  const req = makeMockReq('miner-001')
  const reply = makeMockReply()

  await startMinerLogDownload(ctx, req, reply)

  t.is(reply.statusCode, 202, 'should return 202 Accepted for a read-only token')
  t.is(reply.body.jobId, '12345', 'should include jobId')
  t.pass()
})

test('startMinerLogDownload - forwards the caller permissions as authPerms', async (t) => {
  let capturedPayload = null
  const ctx = makeMockCtx({ write: false, permissions: ['miner:r'] })
  ctx.dataProxy.requestData = async (method, payload) => {
    capturedPayload = payload
    return { id: '12345' }
  }

  await startMinerLogDownload(ctx, makeMockReq('miner-001'), makeMockReply())

  t.alike(capturedPayload.authPerms, ['miner:r'], 'should forward the caller permissions')
  t.pass()
})

test('startMinerLogDownload - returns 400 when action submit fails', async (t) => {
  const ctx = makeMockCtx({ requestDataResult: { id: null, errors: ['ERR_MINER_NOT_FOUND'] } })
  const req = makeMockReq('miner-001')
  const reply = makeMockReply()

  await startMinerLogDownload(ctx, req, reply)

  t.is(reply.statusCode, 400, 'should return 400 when action has no valid id')
  t.ok(reply.body.error, 'should include error message')
  t.pass()
})

test('startMinerLogDownload - returns 400 with error from result when available', async (t) => {
  const ctx = makeMockCtx({ requestDataResult: { id: null, errors: ['ERR_SPECIFIC_FAILURE'] } })
  const req = makeMockReq('miner-001')
  const reply = makeMockReply()

  await startMinerLogDownload(ctx, req, reply)

  t.is(reply.statusCode, 400, 'should return 400')
  t.is(reply.body.error, 'ERR_SPECIFIC_FAILURE', 'should propagate the action error message')
  t.pass()
})

test('startMinerLogDownload - returns 500 on unexpected dataProxy error', async (t) => {
  const ctx = {
    authLib: { getTokenPerms: async () => ({ write: true, permissions: [] }) },
    dataProxy: {
      requestData: async () => { throw new Error('connection refused') }
    }
  }
  const req = makeMockReq('miner-001')
  const reply = makeMockReply()

  await startMinerLogDownload(ctx, req, reply)

  t.is(reply.statusCode, 500, 'should return 500 on unexpected error')
  t.ok(reply.body.error, 'should include error message')
  t.pass()
})

test('startMinerLogDownload - uses minerId from route params', async (t) => {
  let capturedPayload = null
  const ctx = {
    authLib: { getTokenPerms: async () => ({ write: true, permissions: ['admin'] }) },
    dataProxy: {
      requestData: async (method, payload, callback) => {
        capturedPayload = payload
        const arr = []
        const res = { id: '99' }
        callback(res, arr)
        return arr
      }
    }
  }
  const req = makeMockReq('specific-miner-id')
  const reply = makeMockReply()

  await startMinerLogDownload(ctx, req, reply)

  t.is(capturedPayload.query.id, 'specific-miner-id', 'should use minerId from route params')
  t.is(capturedPayload.action, 'downloadLogs', 'should submit downloadLogs action')
  t.pass()
})

// ─────────────────────────────────────────────────────────────────────────────
// getMinerLogDownloadStatus
// ─────────────────────────────────────────────────────────────────────────────

test('getMinerLogDownloadStatus - returns pending when action not in done bucket', async (t) => {
  const ctx = makeMockCtx({ requestDataResult: [] })
  const req = makeMockReq('miner-001', '42')
  const reply = makeMockReply()

  await getMinerLogDownloadStatus(ctx, req, reply)

  t.is(reply.statusCode, 200, 'should return 200')
  t.is(reply.body.status, 'pending', 'should return pending status')
  t.is(reply.body.jobId, '42', 'should echo jobId')
  t.pass()
})

test('getMinerLogDownloadStatus - returns ready with metadata when log is available', async (t) => {
  const expiresAt = Date.now() + 3600000
  const ctx = {
    authLib: { getTokenPerms: async () => ({}) },
    dataProxy: {
      requestData: async () => [makeActionResult({ data: { expiresAt, byteLength: 2048 } })]
    }
  }
  const req = makeMockReq('miner-001', '42')
  const reply = makeMockReply()

  await getMinerLogDownloadStatus(ctx, req, reply)

  t.is(reply.statusCode, 200, 'should return 200')
  t.is(reply.body.status, 'ready', 'should return ready status')
  t.is(reply.body.jobId, '42', 'should echo jobId')
  t.is(reply.body.byteLength, 2048, 'should include byteLength')
  t.is(reply.body.expiresAt, expiresAt, 'should include expiresAt')
  t.ok(reply.body.fileUrl.includes('/file'), 'should include fileUrl')
  t.pass()
})

test('getMinerLogDownloadStatus - returns failed when no coreKey in targets', async (t) => {
  const action = {
    votesPos: ['ops@example.com'],
    targets: {
      'rack-001': {
        calls: [
          { result: { success: false, error_msg: 'ERR_MINER_UNREACHABLE' } }
        ]
      }
    }
  }
  const ctx = {
    authLib: { getTokenPerms: async () => ({}) },
    dataProxy: { requestData: async () => [action] }
  }
  const req = makeMockReq('miner-001', '42')
  const reply = makeMockReply()

  await getMinerLogDownloadStatus(ctx, req, reply)

  t.is(reply.statusCode, 200, 'should return 200')
  t.is(reply.body.status, 'failed', 'should return failed status')
  t.is(reply.body.error, 'ERR_MINER_UNREACHABLE', 'should propagate error message from action result')
  t.pass()
})

test('getMinerLogDownloadStatus - returns failed with generic error when no error_msg', async (t) => {
  const action = {
    votesPos: ['ops@example.com'],
    targets: {
      'rack-001': {
        calls: [{ result: { success: false } }]
      }
    }
  }
  const ctx = {
    authLib: { getTokenPerms: async () => ({}) },
    dataProxy: { requestData: async () => [action] }
  }
  const req = makeMockReq('miner-001', '42')
  const reply = makeMockReply()

  await getMinerLogDownloadStatus(ctx, req, reply)

  t.is(reply.body.status, 'failed', 'should return failed status')
  t.is(reply.body.error, 'ERR_LOG_NOT_AVAILABLE', 'should use fallback error code')
  t.pass()
})

test('getMinerLogDownloadStatus - returns expired when TTL has passed', async (t) => {
  const ctx = {
    authLib: { getTokenPerms: async () => ({}) },
    dataProxy: {
      requestData: async () => [makeActionResult({ data: { expiresAt: Date.now() - 1000 } })]
    }
  }
  const req = makeMockReq('miner-001', '42')
  const reply = makeMockReply()

  await getMinerLogDownloadStatus(ctx, req, reply)

  t.is(reply.statusCode, 200, 'should return 200')
  t.is(reply.body.status, 'expired', 'should return expired status')
  t.is(reply.body.error, 'ERR_LOG_EXPIRED', 'should return ERR_LOG_EXPIRED')
  t.pass()
})

test('getMinerLogDownloadStatus - returns 500 on unexpected dataProxy error', async (t) => {
  const ctx = {
    authLib: { getTokenPerms: async () => ({}) },
    dataProxy: {
      requestData: async () => { throw new Error('redis timeout') }
    }
  }
  const req = makeMockReq('miner-001', '42')
  const reply = makeMockReply()

  await getMinerLogDownloadStatus(ctx, req, reply)

  t.is(reply.statusCode, 500, 'should return 500 on unexpected error')
  t.ok(reply.body.error, 'should include error message')
  t.pass()
})

test('getMinerLogDownloadStatus - failed status carries the worker error code and a readable message', async (t) => {
  const workerErrors = [
    'ERR_DOWNLOAD_LOGS_PARSE_FAILED',
    'ERR_DOWNLOAD_LOGS_FAILED: Code 45',
    'ERR_DOWNLOAD_LOGS_EMPTY',
    'ERR_DOWNLOAD_LOGS_TIMEOUT',
    'ERR_DOWNLOAD_LOGS_INCOMPLETE: connection closed after 10/100 bytes',
    'ERR_DOWNLOAD_LOGS_CONNECT_FAILED: connect ECONNREFUSED'
  ]

  for (const errMsg of workerErrors) {
    const action = {
      votesPos: ['ops@example.com'],
      targets: {
        'rack-001': { calls: [{ result: { success: false, error_msg: errMsg } }] }
      }
    }
    const ctx = {
      authLib: { getTokenPerms: async () => ({}) },
      dataProxy: { requestData: async () => [action] }
    }
    const req = makeMockReq('miner-001', '42')
    const reply = makeMockReply()

    await getMinerLogDownloadStatus(ctx, req, reply)

    t.is(reply.body.status, 'failed', `status should be failed for ${errMsg}`)
    t.is(reply.body.error, errMsg, 'error should carry the raw worker error code')
    t.ok(typeof reply.body.message === 'string' && reply.body.message.length > 0,
      `should include a human-readable message for ${errMsg}`)
    t.not(reply.body.message, errMsg, 'message should not just repeat the raw code')
  }
  t.pass()
})

test('getMinerLogDownloadStatus - returns 403 when the submitter does not match caller', async (t) => {
  const ctx = {
    authLib: { getTokenPerms: async () => ({}) },
    dataProxy: {
      requestData: async () => [makeActionResult({ votesPos: ['other@example.com'] })]
    }
  }
  const req = makeMockReq('miner-001', '42')
  const reply = makeMockReply()

  await getMinerLogDownloadStatus(ctx, req, reply)

  t.is(reply.statusCode, 403, 'should return 403')
  t.is(reply.body.error, 'ERR_AUTH_FAIL_NO_PERMS')
  t.pass()
})

test('getMinerLogDownloadStatus - only the initiating vote counts as owner', async (t) => {
  const ctx = {
    authLib: { getTokenPerms: async () => ({}) },
    dataProxy: {
      requestData: async () => [
        makeActionResult({ votesPos: ['other@example.com', 'ops@example.com'] })
      ]
    }
  }
  const req = makeMockReq('miner-001', '42')
  const reply = makeMockReply()

  await getMinerLogDownloadStatus(ctx, req, reply)

  t.is(reply.statusCode, 403, 'a co-approver is not the job owner')
  t.pass()
})

test('getMinerLogDownloadStatus - returns 404 when minerId mismatches meta', async (t) => {
  const ctx = {
    authLib: { getTokenPerms: async () => ({}) },
    dataProxy: {
      requestData: async () => [makeActionResult({ data: { minerId: 'other-miner' } })]
    }
  }
  const req = makeMockReq('miner-001', '42')
  const reply = makeMockReply()

  await getMinerLogDownloadStatus(ctx, req, reply)

  t.is(reply.statusCode, 404, 'should return 404')
  t.is(reply.body.error, 'ERR_ACTION_NOT_FOUND')
  t.pass()
})

// ─────────────────────────────────────────────────────────────────────────────
// getMinerLogFile
// ─────────────────────────────────────────────────────────────────────────────

test('getMinerLogFile - bridges :jobId to downloadLogFile and returns 404 for unknown action', async (t) => {
  let capturedParams = null
  const ctx = {
    dataProxy: {
      requestData: async (method, params) => {
        capturedParams = { method, params }
        return []
      }
    }
  }
  const req = makeMockReq('miner-001', '42')
  const reply = makeMockReply()

  await getMinerLogFile(ctx, req, reply)

  t.is(capturedParams.method, 'getAction', 'should fetch the action')
  t.is(capturedParams.params.id, '42', 'should pass the jobId as the action id')
  t.is(reply.statusCode, 404, 'should return 404 for unknown action')
  t.is(reply.body.error, 'ERR_ACTION_NOT_FOUND', 'should return ERR_ACTION_NOT_FOUND')
  t.pass()
})

test('getMinerLogFile - returns 410 when log TTL has expired', async (t) => {
  const ctx = {
    dataProxy: {
      requestData: async () => [makeActionResult({ data: { expiresAt: Date.now() - 1000 } })]
    }
  }
  const req = makeMockReq('miner-001', '42')
  const reply = makeMockReply()

  await getMinerLogFile(ctx, req, reply)

  t.is(reply.statusCode, 410, 'should return 410 Gone')
  t.is(reply.body.error, 'ERR_LOG_EXPIRED', 'should return ERR_LOG_EXPIRED')
  t.pass()
})

test('getMinerLogFile - returns 503 when the log peer is unreachable', async (t) => {
  const ctx = {
    dataProxy: {
      requestData: async () => [makeActionResult()]
    },
    logDownloader: {
      stream: async () => { throw new Error('ERR_LOG_PEER_TIMEOUT') }
    }
  }
  const req = makeMockReq('miner-001', '42')
  const reply = makeMockReply()

  await getMinerLogFile(ctx, req, reply)

  t.is(reply.statusCode, 503, 'should return 503 when peer unreachable')
  t.is(reply.body.error, 'ERR_LOG_PEER_TIMEOUT', 'should propagate the peer error code')
  t.pass()
})

// The miner decides the payload format and the action result does not say which, so the file
// leg reads the leading bytes and declares what it actually found. See lib/payloadFormat.

function makeLogStream (payload) {
  let sent = false
  return new Readable({
    read (cb) {
      if (!sent) {
        sent = true
        this.push(payload)
      } else {
        this.push(null)
      }
      cb(null)
    }
  })
}

function makeFileLegCtx (payload) {
  return {
    dataProxy: {
      requestData: async () => [makeActionResult()]
    },
    logDownloader: {
      stream: async () => makeLogStream(payload)
    }
  }
}

async function drain (stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

test('getMinerLogFile - declares .tar.gz for a gzipped tar payload', async (t) => {
  const tar = Buffer.alloc(1024)
  tar.write('10.0.0.1.logs/', 0, 'latin1')
  tar.write('ustar', 257, 'latin1')
  const payload = zlib.gzipSync(tar)

  const reply = makeMockReply()
  await getMinerLogFile(makeFileLegCtx(payload), makeMockReq('miner-001', '42'), reply)

  t.is(
    reply.headers['content-disposition'],
    'attachment; filename="miner-log-miner-001-42.tar.gz"',
    'should name the archive .tar.gz'
  )
  t.is(reply.headers['content-type'], 'application/gzip', 'should declare gzip')
  t.alike(await drain(reply.body), payload, 'should stream every byte, peek included')
})

test('getMinerLogFile - declares .log for a plain-text payload', async (t) => {
  const payload = Buffer.from('[board0]\npass = 1\n')

  const reply = makeMockReply()
  await getMinerLogFile(makeFileLegCtx(payload), makeMockReq('miner-001', '42'), reply)

  t.is(
    reply.headers['content-disposition'],
    'attachment; filename="miner-log-miner-001-42.log"',
    'should name a text log .log'
  )
  t.is(reply.headers['content-type'], 'text/plain; charset=utf-8', 'should declare text')
  t.alike(await drain(reply.body), payload, 'should stream every byte, peek included')
})

test('getMinerLogFile - keeps the byte length and no-store headers', async (t) => {
  const reply = makeMockReply()
  await getMinerLogFile(
    makeFileLegCtx(Buffer.from('log line')),
    makeMockReq('miner-001', '42'),
    reply
  )

  t.is(reply.headers['content-length'], 1024, 'should send the length from the action meta')
  t.is(reply.headers['cache-control'], 'no-store', 'should keep the log out of caches')
})

test('getMinerLogFile - returns 500 when the stream errors before the first byte', async (t) => {
  const ctx = {
    dataProxy: {
      requestData: async () => [makeActionResult()]
    },
    logDownloader: {
      stream: async () => new Readable({
        read (cb) { cb(new Error('ERR_LOG_PEER_TIMEOUT')) }
      })
    }
  }

  const reply = makeMockReply()
  await getMinerLogFile(ctx, makeMockReq('miner-001', '42'), reply)

  t.is(reply.statusCode, 500, 'should return 500')
  t.is(reply.body.error, 'ERR_LOG_PEER_TIMEOUT', 'should propagate the stream error as JSON')
})

test('getMinerLogDownloadStatus - finds successful result across multiple racks', async (t) => {
  const expiresAt = Date.now() + 3600000
  const action = {
    votesPos: ['ops@example.com'],
    targets: {
      'rack-001': {
        calls: [{ result: { success: false, error_msg: 'offline' } }]
      },
      'rack-002': {
        calls: [
          {
            result: {
              success: true,
              data: { coreKey: 'b'.repeat(64), byteLength: 512, expiresAt, minerId: 'miner-002' }
            }
          }
        ]
      }
    }
  }
  const ctx = {
    authLib: { getTokenPerms: async () => ({}) },
    dataProxy: { requestData: async () => [action] }
  }
  const req = makeMockReq('miner-002', '77')
  const reply = makeMockReply()

  await getMinerLogDownloadStatus(ctx, req, reply)

  t.is(reply.body.status, 'ready', 'should return ready when at least one rack has a result')
  t.is(reply.body.byteLength, 512, 'should return correct byteLength from second rack')
  t.pass()
})
