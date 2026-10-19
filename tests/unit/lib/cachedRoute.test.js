'use strict'

const test = require('brittle')
const LRU = require('lru')
const { cachedRoute, clearCachedRoute, sweepExpired } = require('../../../workers/lib/server/lib/cachedRoute')

test('cachedRoute - returns cached value', async (t) => {
  const cachedValue = { data: 'cached' }
  const mockCtx = {
    conf: {
      cacheTiming: {
        '/test': '30s'
      }
    },
    lru_30s: {
      get: (key) => {
        t.is(key, 'test-key', 'should use correct cache key')
        return cachedValue
      },
      set: () => {}
    },
    queuedRequests: new Map()
  }

  const result = await cachedRoute(mockCtx, ['test-key'], '/test', async () => ({ data: 'new' }), false)
  t.is(result.data, 'cached', 'should return cached value')
  t.pass()
})

test('cachedRoute - overwrites cache', async (t) => {
  let setCalled = false
  const newValue = { data: 'new' }
  const mockCtx = {
    conf: {
      cacheTiming: {
        '/test': '30s'
      }
    },
    lru_30s: {
      get: () => ({ data: 'cached' }),
      set: (key, value) => {
        setCalled = true
        t.is(key, 'test-key', 'should use correct cache key')
        t.is(value.data, 'new', 'should set new value')
      }
    },
    queuedRequests: new Map()
  }

  const result = await cachedRoute(mockCtx, ['test-key'], '/test', async () => newValue, true)
  t.is(result.data, 'new', 'should return new value')
  t.ok(setCalled, 'should set cache')
  t.pass()
})

test('cachedRoute - handles queued requests', async (t) => {
  const mockCtx = {
    conf: {
      cacheTiming: {
        '/test': '30s'
      }
    },
    lru_30s: {
      get: () => undefined,
      set: (key, value) => {
        // Simulate queued requests
        const queued = mockCtx.queuedRequests.get('test-key')
        if (queued) {
          queued.forEach(({ resolve }) => resolve(value))
        }
      }
    },
    queuedRequests: new Map()
  }

  // Start first request
  const promise1 = cachedRoute(mockCtx, ['test-key'], '/test', async () => {
    // Simulate slow operation
    await new Promise(resolve => setTimeout(resolve, 50))
    return { data: 'result' }
  }, false)

  // Start second request before first completes
  await new Promise(resolve => setTimeout(resolve, 10))
  const promise2 = cachedRoute(mockCtx, ['test-key'], '/test', async () => {
    return { data: 'result' }
  }, false)

  const [result1, result2] = await Promise.all([promise1, promise2])
  t.is(result1.data, 'result', 'first request should return result')
  t.is(result2.data, 'result', 'second request should return same result')
  t.pass()
})

test('cachedRoute - handles function errors', async (t) => {
  const mockCtx = {
    conf: {
      cacheTiming: {
        '/test': '30s'
      }
    },
    lru_30s: {
      get: () => undefined,
      set: () => {}
    },
    queuedRequests: new Map()
  }

  const testError = new Error('Function error')

  try {
    await cachedRoute(mockCtx, ['test-key'], '/test', async () => {
      throw testError
    }, false)
    t.fail('should throw error')
  } catch (err) {
    t.is(err.message, 'Function error', 'should propagate error')
  }
  t.pass()
})

test('cachedRoute - handles queued request errors', async (t) => {
  const mockCtx = {
    conf: {
      cacheTiming: {
        '/test': '30s'
      }
    },
    lru_30s: {
      get: () => undefined,
      set: () => {}
    },
    queuedRequests: new Map()
  }

  const testError = new Error('Function error')

  // Start first request
  const promise1 = cachedRoute(mockCtx, ['test-key'], '/test', async () => {
    await new Promise(resolve => setTimeout(resolve, 50))
    throw testError
  }, false)

  // Start second request before first completes
  await new Promise(resolve => setTimeout(resolve, 10))
  const promise2 = cachedRoute(mockCtx, ['test-key'], '/test', async () => {
    return { data: 'result' }
  }, false)

  try {
    await Promise.all([promise1, promise2])
    t.fail('should throw error')
  } catch (err) {
    t.is(err.message, 'Function error', 'should propagate error to queued requests')
  }
  t.pass()
})

test('cachedRoute - missing LRU cache', async (t) => {
  const mockCtx = {
    conf: {
      cacheTiming: {
        '/test': '30s'
      }
    },
    lru_30s: null,
    queuedRequests: new Map()
  }

  try {
    await cachedRoute(mockCtx, ['test-key'], '/test', async () => ({}), false)
    t.fail('should throw error')
  } catch (err) {
    t.is(err.message, 'INTERNAL_SERVER_ERROR', 'should throw INTERNAL_SERVER_ERROR')
  }
  t.pass()
})

test('cachedRoute - unknown timing bucket falls back to the default', async (t) => {
  // A config can reference a bucket the running build does not ship yet
  // (deploy-order mismatch) — serve from the default bucket instead of 500ing
  const cachedValue = { data: 'cached' }
  const mockCtx = {
    conf: {
      cacheTiming: {
        '/test': '8s'
      }
    },
    lru_30s: {
      get: (key) => {
        t.is(key, 'test-key', 'should use correct cache key')
        return cachedValue
      },
      set: () => {}
    },
    queuedRequests: new Map()
  }

  const result = await cachedRoute(mockCtx, ['test-key'], '/test', async () => ({ data: 'new' }), false)
  t.is(result.data, 'cached', 'should serve from the default bucket')
  t.pass()
})

test('cachedRoute - null key parts', async (t) => {
  const mockCtx = {
    conf: {
      cacheTiming: {
        '/test': '30s'
      }
    },
    lru_30s: {
      get: (key) => {
        t.is(key, 'test:-:-', 'should handle null key parts as dashes')
        return undefined
      },
      set: () => {}
    },
    queuedRequests: new Map()
  }

  await cachedRoute(mockCtx, ['test', null, null], '/test', async () => ({}), false)
  t.pass()
})

test('cachedRoute - overwriteCache bypasses in-flight dedup and refetches', async (t) => {
  const mockCtx = {
    conf: { cacheTiming: { '/test': '30s' } },
    lru_30s: { get: () => undefined, set: () => {} },
    queuedRequests: new Map()
  }

  let inflightResolved = false
  const inflight = cachedRoute(mockCtx, ['k'], '/test', async () => {
    await new Promise(resolve => setTimeout(resolve, 50))
    inflightResolved = true
    return { data: 'stale' }
  }, false)

  await new Promise(resolve => setTimeout(resolve, 10))
  t.ok(mockCtx.queuedRequests.has('k'), 'a request is already in flight for the key')

  let overwriteRan = false
  const fresh = await cachedRoute(mockCtx, ['k'], '/test', async () => {
    overwriteRan = true
    return { data: 'fresh' }
  }, true)

  t.is(fresh.data, 'fresh', 'overwriteCache returns its own fresh result')
  t.ok(overwriteRan, 'overwriteCache ran its own fetch instead of joining the queue')
  t.absent(inflightResolved, 'overwriteCache did not block on the in-flight request')

  await inflight
  t.pass()
})

test('sweepExpired - evicts entries past maxAge and keeps live ones', async (t) => {
  const cache = new LRU({ max: 100, maxAge: 20 })
  cache.set('old-1', 1)
  cache.set('old-2', 2)
  await new Promise(resolve => setTimeout(resolve, 40))
  cache.set('live', 3)

  const evicted = sweepExpired({ cache })

  t.is(evicted, 2, 'two expired entries evicted')
  t.alike(cache.keys, ['live'], 'live entry kept')
  t.is(cache.get('live'), 3, 'live entry still readable')
})

test('sweepExpired - tolerates a stopped facility', (t) => {
  t.is(sweepExpired({}), 0)
  t.is(sweepExpired(undefined), 0)
})

test('clearCachedRoute - removes every key of the route in its bucket and nothing else', (t) => {
  const cache = new LRU({ max: 100 })
  cache.set('metrics/consumption:phase-1:1:2:-:-:-:-', 1)
  cache.set('metrics/consumption:-:3:4:1h:-:-:-', 2)
  cache.set('metrics/consumption-other:x', 3)
  cache.set('metrics/efficiency:phase-1', 4)
  const ctx = { conf: { cacheTiming: {} }, lru_30s: { cache } }

  const removed = clearCachedRoute(ctx, '/auth/metrics/consumption', 'metrics/consumption')

  t.is(removed, 2)
  t.alike(cache.keys.sort(), ['metrics/consumption-other:x', 'metrics/efficiency:phase-1'])
})

test('clearCachedRoute - uses the configured bucket and tolerates a missing one', (t) => {
  const cache = new LRU({ max: 100 })
  cache.set('route:a', 1)
  const ctx = { conf: { cacheTiming: { '/route': '1m' } }, lru_1m: { cache } }

  t.is(clearCachedRoute(ctx, '/route', 'route'), 1)
  t.is(cache.keys.length, 0)
  t.is(clearCachedRoute({ conf: { cacheTiming: {} } }, '/route', 'route'), 0, 'no bucket, no throw')
})
