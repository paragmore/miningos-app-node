'use strict'

const test = require('brittle')
const { createDataProxy } = require('../../../workers/lib/data.proxy')

const createCtx = (jRequest) => ({
  conf: { orks: [{ rpcPublicKey: 'key1' }], rpcTimeout: 100 },
  net_r0: { jRequest }
})

const silenceWarnings = (t) => {
  const original = console.warn
  console.warn = () => {}
  t.teardown(() => { console.warn = original })
}

test('requestDataMap - retries a closed channel and returns the retried result', async (t) => {
  silenceWarnings(t)

  let calls = 0
  const ctx = createCtx(async () => {
    calls++
    if (calls === 1) throw new Error('CHANNEL_CLOSED: channel closed')
    return [{ ts: 1 }]
  })

  const result = await createDataProxy(ctx).requestDataMap('tailLogMulti', {})

  t.is(calls, 2, 'should retry once after the channel closed')
  t.alike(result, [[{ ts: 1 }]], 'should return the successful retry payload')
})

test('requestDataMap - gives up after the maximum attempts', async (t) => {
  silenceWarnings(t)

  let calls = 0
  const ctx = createCtx(async () => {
    calls++
    throw new Error('CHANNEL_CLOSED: channel closed')
  })

  await t.exception(
    createDataProxy(ctx).requestDataMap('tailLogMulti', {}),
    /CHANNEL_CLOSED/,
    'should propagate the error once retries are exhausted'
  )
  t.is(calls, 3, 'should stop at RPC_MAX_ATTEMPTS')
})

test('requestDataMap - does not retry a non-transient error', async (t) => {
  let calls = 0
  const ctx = createCtx(async () => {
    calls++
    throw new Error('ERR_FIELDS_INVALID_JSON')
  })

  await t.exception(
    createDataProxy(ctx).requestDataMap('tailLogMulti', {}),
    /ERR_FIELDS_INVALID_JSON/,
    'should propagate immediately'
  )
  t.is(calls, 1, 'should not retry')
})

test('requestDataMap - drops a failed ork and keeps the rest', async (t) => {
  silenceWarnings(t)

  const ctx = {
    conf: { orks: [{ rpcPublicKey: 'bad' }, { rpcPublicKey: 'good' }], rpcTimeout: 100 },
    net_r0: {
      jRequest: async (publicKey) => {
        if (publicKey === 'bad') throw new Error('ERR_ORK_DOWN')
        return [{ ts: 2 }]
      }
    }
  }

  const result = await createDataProxy(ctx).requestDataMap('tailLogMulti', {})

  t.alike(result, [[{ ts: 2 }]], 'should return only the healthy ork payload')
})

test('requestDataMap - throws when every ork fails', async (t) => {
  silenceWarnings(t)

  const ctx = {
    conf: { orks: [{ rpcPublicKey: 'a' }, { rpcPublicKey: 'b' }], rpcTimeout: 100 },
    net_r0: { jRequest: async () => { throw new Error('ERR_ORK_DOWN') } }
  }

  await t.exception(
    createDataProxy(ctx).requestDataMap('tailLogMulti', {}),
    /ERR_ORK_DOWN/,
    'should not degrade a total outage into an empty result'
  )
})

test('requestDataMap - returns an empty list when no orks are configured', async (t) => {
  const ctx = { conf: { orks: [] }, net_r0: { jRequest: async () => [] } }

  const result = await createDataProxy(ctx).requestDataMap('tailLogMulti', {})

  t.alike(result, [], 'should return an empty array')
})

test('requestData - retries a closed channel per store', async (t) => {
  silenceWarnings(t)

  let calls = 0
  const ctx = createCtx(async () => {
    calls++
    if (calls === 1) throw new Error('channel closed')
    return { ok: true }
  })

  const result = await createDataProxy(ctx).requestData('tailLog', {})

  t.is(calls, 2, 'should retry once')
  t.alike(result, [{ ok: true }], 'should collect the retried result')
})

// A channel can drop after the ork applied the request, so a retried write can
// execute twice — and a single pushAction carries no idempotency key. Writes must
// keep failing on the first CHANNEL_CLOSED.
test('requestData - does not retry a write on a closed channel', async (t) => {
  let calls = 0
  const ctx = createCtx(async () => {
    calls++
    throw new Error('CHANNEL_CLOSED: channel closed')
  })

  const result = await createDataProxy(ctx).requestData('pushAction', {})

  t.is(calls, 1, 'should attempt a miner control action exactly once')
  t.alike(
    result,
    [{ error: 'CHANNEL_CLOSED: channel closed' }],
    'should surface the failure instead of re-sending the action'
  )
})

test('requestDataMap - does not retry a write on a closed channel', async (t) => {
  silenceWarnings(t)

  let calls = 0
  const ctx = createCtx(async () => {
    calls++
    throw new Error('CHANNEL_CLOSED: channel closed')
  })

  await t.exception(
    createDataProxy(ctx).requestDataMap('setGlobalConfig', {}),
    /CHANNEL_CLOSED/,
    'should propagate rather than re-apply the config write'
  )
  t.is(calls, 1, 'should attempt the write exactly once')
})

test('requestData - does not retry a method it does not recognise', async (t) => {
  let calls = 0
  const ctx = createCtx(async () => {
    calls++
    throw new Error('CHANNEL_CLOSED: channel closed')
  })

  // things.handlers passes the comment operation through dynamically, so an
  // unlisted method must default to no retry rather than to retrying
  await createDataProxy(ctx).requestData('someFutureMethod', {})

  t.is(calls, 1, 'should not retry an unlisted method')
})

test('requestDataAllPages - retries a closed channel on a read method', async (t) => {
  silenceWarnings(t)

  let calls = 0
  const ctx = createCtx(async () => {
    calls++
    if (calls === 1) throw new Error('CHANNEL_CLOSED: channel closed')
    return []
  })

  const result = await createDataProxy(ctx).requestDataAllPages('listThings', {})

  t.is(calls, 2, 'should retry the page fetch')
  t.alike(result, [[]], 'should return the empty page set')
})
