'use strict'

const test = require('brittle')

const {
  queryActionsBatch,
  queryActions,
  getAction,
  pushAction,
  pushActionsBatch,
  voteAction,
  cancelActionsBatch
} = require('../../../workers/lib/server/handlers/actions.handlers')
const { createMockCtxWithOrks, createMockReq, withDataProxy } = require('../helpers/mockHelpers')

const APPROVED_POOL_URLS = [
  { id: 'pool-1', host: 'pool.example.com', port: 3333, name: 'Example Pool' },
  { id: 'pool-2', host: 'backup.example.com', port: 4444, name: 'Backup Pool' }
]

test('queryActionsBatch - basic functionality', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [
      { rpcPublicKey: 'key1' },
      { rpcPublicKey: 'key2' }
    ],
    async (key, method, payload, opts) => {
      return [{ id: 'action1', result: 'success' }]
    }
  )

  const mockReq = createMockReq({ ids: 'id1,id2,id3' })

  const result = await queryActionsBatch(mockCtx, mockReq)

  t.ok(Array.isArray(result), 'should return array')
  t.ok(result.length > 0, 'should have results')

  t.pass()
})

test('queryActionsBatch - handles errors gracefully', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async () => {
      throw new Error('Network error')
    }
  )

  const mockReq = createMockReq({ ids: 'id1' })

  const result = await queryActionsBatch(mockCtx, mockReq)

  t.ok(Array.isArray(result), 'should return array even on error')
  t.is(result.length, 0, 'should return empty array on error')

  t.pass()
})

test('queryActions - with queries parameter', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async (key, method, payload, opts) => {
      return { actions: [] }
    }
  )

  const mockReq = createMockReq({ queries: '[{"type": "voting", "query": {"status": "pending"}}]' })

  const result = await queryActions(mockCtx, mockReq)

  t.ok(Array.isArray(result), 'should return array')

  t.pass()
})

test('queryActions - with invalid queries JSON', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: []
    },
    net_r0: {
      jRequest: async () => ({})
    }
  })

  const mockReq = {
    query: { queries: 'invalid-json' }
  }

  try {
    await queryActions(mockCtx, mockReq)
    t.fail('should throw error for invalid JSON')
  } catch (err) {
    t.is(err.message, 'ERR_QUERIES_INVALID_JSON', 'should throw ERR_QUERIES_INVALID_JSON')
  }

  t.pass()
})

test('queryActions - with groupBatch parameter', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [
        { rpcPublicKey: 'key1' }
      ]
    },
    net_r0: {
      jRequest: async (key, method, payload, opts) => {
        return { actions: [] }
      }
    }
  })

  const mockReq = {
    query: { groupBatch: 'true' }
  }

  const result = await queryActions(mockCtx, mockReq)

  t.ok(Array.isArray(result), 'should return array')

  t.pass()
})

test('queryActions - handles network errors', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [
        { rpcPublicKey: 'key1' }
      ]
    },
    net_r0: {
      jRequest: async () => {
        throw new Error('Network error')
      }
    }
  })

  const mockReq = {
    query: {}
  }

  const result = await queryActions(mockCtx, mockReq)

  t.ok(Array.isArray(result), 'should return array')
  t.ok(result[0].error, 'should include error in result')

  t.pass()
})

test('getAction - basic functionality', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [
        { rpcPublicKey: 'key1' }
      ]
    },
    net_r0: {
      jRequest: async (key, method, payload, opts) => {
        return { id: payload.id, type: payload.type }
      }
    }
  })

  const mockReq = {
    params: { id: 'action123', type: 'test' }
  }

  const result = await getAction(mockCtx, mockReq)

  t.ok(Array.isArray(result), 'should return array')
  t.ok(result[0].id === 'action123', 'should return correct action id')

  t.pass()
})

test('getAction - handles errors', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [
        { rpcPublicKey: 'key1' }
      ]
    },
    net_r0: {
      jRequest: async () => {
        throw new Error('Action not found')
      }
    }
  })

  const mockReq = {
    params: { id: 'nonexistent', type: 'test' }
  }

  const result = await getAction(mockCtx, mockReq)

  t.ok(Array.isArray(result), 'should return array')
  t.ok(result[0].error, 'should include error in result')

  t.pass()
})

test('pushAction - requires write permission', async (t) => {
  const mockCtx = {
    authLib: {
      getTokenPerms: async () => ({ write: false, permissions: [] })
    }
  }

  const mockReq = {
    _info: { authToken: 'token123' }
  }

  try {
    await pushAction(mockCtx, mockReq)
    t.fail('should throw error for missing write permission')
  } catch (err) {
    t.is(err.message, 'ERR_WRITE_PERM_REQUIRED', 'should throw ERR_WRITE_PERM_REQUIRED')
  }

  t.pass()
})

test('pushAction - with valid permissions', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [
        { rpcPublicKey: 'key1' }
      ]
    },
    authLib: {
      getTokenPerms: async () => ({
        write: true,
        permissions: ['actions:write']
      })
    },
    net_r0: {
      jRequest: async (key, method, payload, opts) => {
        return { id: 'new-action', success: true }
      }
    }
  })

  const mockReq = {
    _info: {
      authToken: 'token123',
      user: { metadata: { email: 'test@example.com' } }
    },
    body: {
      query: { status: 'pending' },
      action: 'test-action',
      params: { test: 'value' }
    }
  }

  const result = await pushAction(mockCtx, mockReq)

  t.ok(Array.isArray(result), 'should return array')
  t.ok(result[0].id === 'new-action', 'should return new action id')

  t.pass()
})

for (const action of ['registerConfig', 'updateConfig']) {
  test(`pushAction - ${action} resolves poolUrls to approved pool url/worker settings`, async (t) => {
    let capturedPayload = null
    const mockCtx = withDataProxy({
      conf: {
        orks: [
          { rpcPublicKey: 'key1' }
        ]
      },
      authLib: {
        getTokenPerms: async () => ({
          write: true,
          permissions: ['actions:write']
        })
      },
      net_r0: {
        jRequest: async (key, method, payload, opts) => {
          if (method === 'getGlobalConfig') {
            return { approvedPoolUrls: APPROVED_POOL_URLS }
          }
          capturedPayload = payload
          return { id: 'new-action', success: true }
        }
      }
    })

    const mockReq = {
      _info: {
        authToken: 'token123',
        user: { metadata: { email: 'test@example.com' } }
      },
      body: {
        action,
        params: [{
          name: 'my-config',
          data: {
            poolUrls: APPROVED_POOL_URLS.map((config) => ({
              poolUrlId: config.id,
              workerName: `${config.id}-worker`,
              workerPassword: 'x'
            }))
          }
        }]
      }
    }

    const result = await pushAction(mockCtx, mockReq)

    t.ok(Array.isArray(result), 'should return array')
    t.ok(result[0].id === 'new-action', 'should return new action id')

    const [poolConfig] = capturedPayload.params
    t.is(poolConfig.data.poolUrls.length, APPROVED_POOL_URLS.length, 'should resolve one entry per approved pool')
    poolConfig.data.poolUrls.forEach((resolved, i) => {
      const approved = APPROVED_POOL_URLS[i]
      t.is(resolved.poolUrlId, approved.id, 'poolUrlId should be preserved on the resolved entry')
      t.is(resolved.url, `stratum+tcp://${approved.host}:${approved.port}`, 'url should be built from host and port')
      t.is(resolved.pool, approved.name, 'pool should be the approved config name')
      t.is(resolved.workerName, `${approved.id}-worker`, 'workerName should pass through from the request')
      t.is(resolved.workerPassword, 'x', 'workerPassword should pass through from the request')
    })

    t.pass()
  })

  test(`pushAction - ${action} does not double-prefix a host that already includes the pool protocol`, async (t) => {
    let capturedPayload = null
    const prefixedPoolUrl = { id: 'pool-prefixed', host: 'stratum+tcp://already-prefixed.example.com', port: 3333, name: 'Prefixed Pool' }
    const mockCtx = withDataProxy({
      conf: { orks: [{ rpcPublicKey: 'key1' }] },
      authLib: {
        getTokenPerms: async () => ({ write: true, permissions: ['actions:write'] })
      },
      net_r0: {
        jRequest: async (key, method, payload, opts) => {
          if (method === 'getGlobalConfig') {
            return { approvedPoolUrls: [prefixedPoolUrl] }
          }
          capturedPayload = payload
          return { id: 'new-action', success: true }
        }
      }
    })

    const mockReq = {
      _info: {
        authToken: 'token123',
        user: { metadata: { email: 'test@example.com' } }
      },
      body: {
        action,
        params: [{
          name: 'my-config',
          data: {
            poolUrls: [{
              poolUrlId: prefixedPoolUrl.id,
              workerName: 'worker1',
              workerPassword: 'x'
            }]
          }
        }]
      }
    }

    await pushAction(mockCtx, mockReq)

    const [poolConfig] = capturedPayload.params
    const [resolved] = poolConfig.data.poolUrls
    t.is(resolved.url, `${prefixedPoolUrl.host}:${prefixedPoolUrl.port}`, 'url should not have the protocol prepended twice')
    t.absent(resolved.url.startsWith('stratum+tcp://stratum+tcp://'), 'url should not contain a doubled protocol')

    t.pass()
  })

  test(`pushAction - ${action} adds the pool protocol when the host does not already include it`, async (t) => {
    let capturedPayload = null
    const mockCtx = withDataProxy({
      conf: { orks: [{ rpcPublicKey: 'key1' }] },
      authLib: {
        getTokenPerms: async () => ({ write: true, permissions: ['actions:write'] })
      },
      net_r0: {
        jRequest: async (key, method, payload, opts) => {
          if (method === 'getGlobalConfig') {
            return { approvedPoolUrls: APPROVED_POOL_URLS }
          }
          capturedPayload = payload
          return { id: 'new-action', success: true }
        }
      }
    })

    const approved = APPROVED_POOL_URLS[0]
    const mockReq = {
      _info: {
        authToken: 'token123',
        user: { metadata: { email: 'test@example.com' } }
      },
      body: {
        action,
        params: [{
          name: 'my-config',
          data: {
            poolUrls: [{
              poolUrlId: approved.id,
              workerName: 'worker1',
              workerPassword: 'x'
            }]
          }
        }]
      }
    }

    await pushAction(mockCtx, mockReq)

    const [poolConfig] = capturedPayload.params
    const [resolved] = poolConfig.data.poolUrls
    t.is(resolved.url, `stratum+tcp://${approved.host}:${approved.port}`, 'url should be prefixed with the pool protocol')

    t.pass()
  })

  test(`pushAction - ${action} disregards a url sent from the client`, async (t) => {
    let capturedPayload = null
    const mockCtx = withDataProxy({
      conf: { orks: [{ rpcPublicKey: 'key1' }] },
      authLib: {
        getTokenPerms: async () => ({ write: true, permissions: ['actions:write'] })
      },
      net_r0: {
        jRequest: async (key, method, payload, opts) => {
          if (method === 'getGlobalConfig') {
            return { approvedPoolUrls: APPROVED_POOL_URLS }
          }
          capturedPayload = payload
          return { id: 'new-action', success: true }
        }
      }
    })

    const approved = APPROVED_POOL_URLS[0]
    const mockReq = {
      _info: {
        authToken: 'token123',
        user: { metadata: { email: 'test@example.com' } }
      },
      body: {
        action,
        params: [{
          name: 'my-config',
          data: {
            poolUrls: [{
              poolUrlId: approved.id,
              url: 'stratum+tcp://attacker-controlled.example.com:9999',
              workerName: 'worker1',
              workerPassword: 'secret'
            }]
          }
        }]
      }
    }

    await pushAction(mockCtx, mockReq)

    const [poolConfig] = capturedPayload.params
    const [resolved] = poolConfig.data.poolUrls
    t.is(resolved.url, `stratum+tcp://${approved.host}:${approved.port}`, 'url should be rebuilt from the approved pool config, not the client-supplied url')
    t.not(resolved.url, 'stratum+tcp://attacker-controlled.example.com:9999', 'client-supplied url should never reach the payload')

    t.pass()
  })

  test(`pushAction - ${action} fetches approved pool urls from ork global config`, async (t) => {
    let getGlobalConfigCalls = 0
    const mockCtx = withDataProxy({
      conf: { orks: [{ rpcPublicKey: 'key1' }] },
      authLib: {
        getTokenPerms: async () => ({ write: true, permissions: ['actions:write'] })
      },
      net_r0: {
        jRequest: async (key, method, payload, opts) => {
          if (method === 'getGlobalConfig') {
            getGlobalConfigCalls++
            return { approvedPoolUrls: APPROVED_POOL_URLS }
          }
          return { id: 'new-action', success: true }
        }
      }
    })

    const approved = APPROVED_POOL_URLS[0]
    const mockReq = {
      _info: {
        authToken: 'token123',
        user: { metadata: { email: 'test@example.com' } }
      },
      body: {
        action,
        params: [{
          name: 'my-config',
          data: { poolUrls: [{ poolUrlId: approved.id, workerName: 'worker1', workerPassword: 'x' }] }
        }]
      }
    }

    await pushAction(mockCtx, mockReq)

    t.ok(getGlobalConfigCalls > 0, 'should fetch global config from the orks instead of a static constant')

    t.pass()
  })

  test(`pushAction - ${action} throws for unknown poolUrlId when no ork reports approvedPoolUrls`, async (t) => {
    const mockCtx = withDataProxy({
      conf: { orks: [{ rpcPublicKey: 'key1' }] },
      authLib: {
        getTokenPerms: async () => ({ write: true, permissions: ['actions:write'] })
      },
      net_r0: {
        jRequest: async (key, method, payload, opts) => {
          if (method === 'getGlobalConfig') {
            return {}
          }
          return { id: 'new-action', success: true }
        }
      }
    })

    const approved = APPROVED_POOL_URLS[0]
    const mockReq = {
      _info: {
        authToken: 'token123',
        user: { metadata: { email: 'test@example.com' } }
      },
      body: {
        action,
        params: [{
          name: 'my-config',
          data: { poolUrls: [{ poolUrlId: approved.id, workerName: 'worker1', workerPassword: 'x' }] }
        }]
      }
    }

    try {
      await pushAction(mockCtx, mockReq)
      t.fail('should throw error when no ork reports approved pool urls')
    } catch (err) {
      t.is(err.message, 'ERR_INVALID_POOL_URL_ID_INVALID', 'should throw ERR_INVALID_POOL_URL_ID_INVALID')
    }

    t.pass()
  })

  test(`pushAction - ${action} resolves poolUrls when only one ork reports approvedPoolUrls`, async (t) => {
    let capturedPayload = null
    const mockCtx = withDataProxy({
      conf: {
        orks: [
          { rpcPublicKey: 'key1' },
          { rpcPublicKey: 'key2' }
        ]
      },
      authLib: {
        getTokenPerms: async () => ({ write: true, permissions: ['actions:write'] })
      },
      net_r0: {
        jRequest: async (key, method, payload, opts) => {
          if (method === 'getGlobalConfig') {
            return key === 'key1' ? { approvedPoolUrls: APPROVED_POOL_URLS } : {}
          }
          capturedPayload = payload
          return { id: 'new-action', success: true }
        }
      }
    })

    const approved = APPROVED_POOL_URLS[0]
    const mockReq = {
      _info: {
        authToken: 'token123',
        user: { metadata: { email: 'test@example.com' } }
      },
      body: {
        action,
        params: [{
          name: 'my-config',
          data: { poolUrls: [{ poolUrlId: approved.id, workerName: 'worker1', workerPassword: 'x' }] }
        }]
      }
    }

    await pushAction(mockCtx, mockReq)

    const [poolConfig] = capturedPayload.params
    const [resolved] = poolConfig.data.poolUrls
    t.is(resolved.url, `stratum+tcp://${approved.host}:${approved.port}`, 'should resolve using the ork that reported approvedPoolUrls')

    t.pass()
  })

  test(`pushAction - ${action} throws for missing/invalid poolUrls`, async (t) => {
    const mockCtx = withDataProxy({
      conf: { orks: [{ rpcPublicKey: 'key1' }] },
      authLib: {
        getTokenPerms: async () => ({ write: true, permissions: [] })
      },
      net_r0: {
        jRequest: async () => ({ id: 'new-action', success: true })
      }
    })

    const mockReq = {
      _info: {
        authToken: 'token123',
        user: { metadata: { email: 'test@example.com' } }
      },
      body: {
        action,
        params: [{ name: 'my-config', data: {} }]
      }
    }

    try {
      await pushAction(mockCtx, mockReq)
      t.fail('should throw error for missing poolUrls')
    } catch (err) {
      t.is(err.message, 'ERR_INVALID_POOL_URLS', 'should throw ERR_INVALID_POOL_URLS')
    }

    t.pass()
  })

  test(`pushAction - ${action} throws when a poolUrl entry is missing poolUrlId`, async (t) => {
    const mockCtx = withDataProxy({
      conf: { orks: [{ rpcPublicKey: 'key1' }] },
      authLib: {
        getTokenPerms: async () => ({ write: true, permissions: [] })
      },
      net_r0: {
        jRequest: async () => ({ id: 'new-action', success: true })
      }
    })

    const mockReq = {
      _info: {
        authToken: 'token123',
        user: { metadata: { email: 'test@example.com' } }
      },
      body: {
        action,
        params: [{ name: 'my-config', data: { poolUrls: [{ workerName: 'worker1' }] } }]
      }
    }

    try {
      await pushAction(mockCtx, mockReq)
      t.fail('should throw error for missing poolUrlId')
    } catch (err) {
      t.is(err.message, 'ERR_INVALID_POOL_URL_ID_MISSING', 'should throw ERR_INVALID_POOL_URL_ID_MISSING')
    }

    t.pass()
  })

  test(`pushAction - ${action} throws for unknown poolUrlId`, async (t) => {
    const mockCtx = withDataProxy({
      conf: { orks: [{ rpcPublicKey: 'key1' }] },
      authLib: {
        getTokenPerms: async () => ({ write: true, permissions: [] })
      },
      net_r0: {
        jRequest: async () => ({ id: 'new-action', success: true })
      }
    })

    const mockReq = {
      _info: {
        authToken: 'token123',
        user: { metadata: { email: 'test@example.com' } }
      },
      body: {
        action,
        params: [{ name: 'my-config', data: { poolUrls: [{ poolUrlId: 'does-not-exist' }] } }]
      }
    }

    try {
      await pushAction(mockCtx, mockReq)
      t.fail('should throw error for unknown poolUrlId')
    } catch (err) {
      t.is(err.message, 'ERR_INVALID_POOL_URL_ID_INVALID', 'should throw ERR_INVALID_POOL_URL_ID_INVALID')
    }

    t.pass()
  })

  test(`pushAction - ${action} with no pool config passes params through unchanged`, async (t) => {
    let capturedPayload = null
    const mockCtx = withDataProxy({
      conf: { orks: [{ rpcPublicKey: 'key1' }] },
      authLib: {
        getTokenPerms: async () => ({ write: true, permissions: [] })
      },
      net_r0: {
        jRequest: async (key, method, payload, opts) => {
          capturedPayload = payload
          return { id: 'new-action', success: true }
        }
      }
    })

    const mockReq = {
      _info: {
        authToken: 'token123',
        user: { metadata: { email: 'test@example.com' } }
      },
      body: {
        action,
        params: []
      }
    }

    const result = await pushAction(mockCtx, mockReq)

    t.ok(Array.isArray(result), 'should return array')
    t.alike(capturedPayload.params, [], 'params should pass through unchanged when no pool config present')

    t.pass()
  })

  test(`pushAction - ${action} throws ERR_INVALID_PAYLOAD when params is not an array`, async (t) => {
    const mockCtx = withDataProxy({
      conf: { orks: [{ rpcPublicKey: 'key1' }] },
      authLib: {
        getTokenPerms: async () => ({ write: true, permissions: [] })
      },
      net_r0: {
        jRequest: async () => ({ id: 'new-action', success: true })
      }
    })

    const mockReq = {
      _info: {
        authToken: 'token123',
        user: { metadata: { email: 'test@example.com' } }
      },
      body: {
        action,
        params: { name: 'my-config' }
      }
    }

    try {
      await pushAction(mockCtx, mockReq)
      t.fail('should throw error for non-array params')
    } catch (err) {
      t.is(err.message, 'ERR_INVALID_PAYLOAD', 'should throw ERR_INVALID_PAYLOAD')
    }

    t.pass()
  })
}

test('pushActionsBatch - requires write permission', async (t) => {
  const mockCtx = {
    authLib: {
      getTokenPerms: async () => ({ write: false, permissions: [] })
    }
  }

  const mockReq = {
    _info: { authToken: 'token123' }
  }

  try {
    await pushActionsBatch(mockCtx, mockReq)
    t.fail('should throw error for missing write permission')
  } catch (err) {
    t.is(err.message, 'ERR_WRITE_PERM_REQUIRED', 'should throw ERR_WRITE_PERM_REQUIRED')
  }

  t.pass()
})

test('pushActionsBatch - validates batchActionsPayload array', async (t) => {
  const mockCtx = {
    authLib: {
      getTokenPerms: async () => ({ write: true, permissions: [] })
    }
  }

  const mockReq = {
    _info: {
      authToken: 'token123',
      user: { metadata: { email: 'test@example.com' } }
    },
    body: {
      batchActionsPayload: 'not-an-array'
    }
  }

  try {
    await pushActionsBatch(mockCtx, mockReq)
    t.fail('should throw error for invalid batchActionsPayload')
  } catch (err) {
    t.is(err.message, 'ERR_BATCH_ACTIONS_PAYLOAD_INVALID_ARRAY', 'should throw ERR_BATCH_ACTIONS_PAYLOAD_INVALID_ARRAY')
  }

  t.pass()
})

test('pushActionsBatch - with valid data', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [
        { rpcPublicKey: 'key1' }
      ]
    },
    authLib: {
      getTokenPerms: async () => ({
        write: true,
        permissions: ['actions:write']
      })
    },
    net_r0: {
      jRequest: async (key, method, payload, opts) => {
        return { id: 'batch-action', success: true }
      }
    }
  })

  const mockReq = {
    _info: {
      authToken: 'token123',
      user: { metadata: { email: 'test@example.com' } }
    },
    body: {
      batchActionsPayload: [{ action: 'test1' }, { action: 'test2' }],
      batchActionUID: 'batch-123'
    }
  }

  const result = await pushActionsBatch(mockCtx, mockReq)

  t.ok(Array.isArray(result), 'should return array')
  t.ok(result[0].id === 'batch-action', 'should return batch action id')

  t.pass()
})

test('voteAction - requires write permission', async (t) => {
  const mockCtx = {
    authLib: {
      getTokenPerms: async () => ({ write: false, caps: [] })
    }
  }

  const mockReq = {
    _info: { authToken: 'token123' }
  }

  try {
    await voteAction(mockCtx, mockReq)
    t.fail('should throw error for missing write permission')
  } catch (err) {
    t.is(err.message, 'ERR_WRITE_PERM_REQUIRED', 'should throw ERR_WRITE_PERM_REQUIRED')
  }

  t.pass()
})

test('voteAction - with valid permissions', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [
        { rpcPublicKey: 'key1' }
      ]
    },
    authLib: {
      getTokenPerms: async () => ({
        write: true,
        caps: ['actions:vote']
      })
    },
    net_r0: {
      jRequest: async (key, method, payload, opts) => {
        return { success: true, vote: payload.approve }
      }
    }
  })

  const mockReq = {
    _info: {
      authToken: 'token123',
      user: { metadata: { email: 'test@example.com' } }
    },
    params: { id: 'action123' },
    body: { approve: true }
  }

  const result = await voteAction(mockCtx, mockReq)

  t.ok(Array.isArray(result), 'should return array')
  t.ok(result[0].res.success === true, 'should return successful vote')

  t.pass()
})

test('cancelActionsBatch - requires write permission', async (t) => {
  const mockCtx = {
    authLib: {
      getTokenPerms: async () => ({ write: false })
    }
  }

  const mockReq = {
    _info: { authToken: 'token123' }
  }

  try {
    await cancelActionsBatch(mockCtx, mockReq)
    t.fail('should throw error for missing write permission')
  } catch (err) {
    t.is(err.message, 'ERR_WRITE_PERM_REQUIRED', 'should throw ERR_WRITE_PERM_REQUIRED')
  }

  t.pass()
})

test('cancelActionsBatch - with valid permissions', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [
        { rpcPublicKey: 'key1' }
      ]
    },
    authLib: {
      getTokenPerms: async () => ({ write: true })
    },
    net_r0: {
      jRequest: async (key, method, payload, opts) => {
        return { success: true, cancelled: payload.ids }
      }
    }
  })

  const mockReq = {
    _info: {
      authToken: 'token123',
      user: { metadata: { email: 'test@example.com' } }
    },
    query: { ids: 'action1,action2' }
  }

  const result = await cancelActionsBatch(mockCtx, mockReq)

  t.ok(Array.isArray(result), 'should return array')
  t.ok(result[0].res.success === true, 'should return successful cancellation')

  t.pass()
})

test('cancelActionsBatch - handles errors', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [
        { rpcPublicKey: 'key1' }
      ]
    },
    authLib: {
      getTokenPerms: async () => ({ write: true })
    },
    net_r0: {
      jRequest: async () => {
        throw new Error('Cancellation failed')
      }
    }
  })

  const mockReq = {
    _info: {
      authToken: 'token123',
      user: { metadata: { email: 'test@example.com' } }
    },
    query: { ids: 'action1' }
  }

  const result = await cancelActionsBatch(mockCtx, mockReq)

  t.ok(Array.isArray(result), 'should return array')
  t.ok(result[0].res.success === false, 'should return failed cancellation')
  t.ok(result[0].res.error, 'should include error message')

  t.pass()
})
