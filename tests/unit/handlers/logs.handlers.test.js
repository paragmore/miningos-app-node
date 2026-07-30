'use strict'

const test = require('brittle')
const {
  tailLogRoute,
  tailLogMultiRoute,
  tailLogRangeAggrRoute,
  getHistoryLogRoute
} = require('../../../workers/lib/server/handlers/logs.handlers')
const { createMockCtxWithOrks, createMockReq } = require('../helpers/mockHelpers')

test('tailLogRoute - basic functionality', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [
      { rpcPublicKey: 'key1' },
      { rpcPublicKey: 'key2' }
    ],
    async (key, method, query) => {
      t.is(method, 'tailLog', 'should call tailLog')
      return [{ id: 1 }]
    }
  )
  const mockReq = createMockReq()

  const result = await tailLogRoute(mockCtx, mockReq, {})

  t.ok(Array.isArray(result), 'should return array')
  t.is(result.length, 2, 'should merge logs')

  t.pass()
})

test('tailLogRoute - with fields parameter', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async (key, method, query) => {
      t.ok(query.fields, 'should parse fields')
      return []
    }
  )
  const mockReq = createMockReq({ fields: '{"id":1,"name":1}' })

  await tailLogRoute(mockCtx, mockReq, {})

  t.pass()
})

test('tailLogRoute - with aggrFields parameter', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async (key, method, query) => {
      t.ok(query.aggrFields, 'should parse aggrFields')
      return []
    }
  )
  const mockReq = createMockReq({ aggrFields: '{"field1":1}' })

  await tailLogRoute(mockCtx, mockReq, {})

  t.pass()
})

test('tailLogRoute - with aggrTimes parameter', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async (key, method, query) => {
      t.ok(Array.isArray(query.aggrTimes), 'should parse aggrTimes as array')
      return []
    }
  )
  const mockReq = createMockReq({ aggrTimes: '[1,2,3]' })

  await tailLogRoute(mockCtx, mockReq, {})

  t.pass()
})

test('tailLogRoute - with invalid aggrTimes (not array)', async (t) => {
  const mockReq = createMockReq({ aggrTimes: '{"not":"array"}' })

  try {
    await tailLogRoute({ conf: { orks: [] } }, mockReq, {})
    t.fail('should throw error for invalid aggrTimes')
  } catch (err) {
    t.is(err.message, 'ERR_AGGRTIMES_INVALID_ARRAY', 'should throw ERR_AGGRTIMES_INVALID_ARRAY')
  }

  t.pass()
})

test('tailLogMultiRoute - basic functionality', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async (key, method, query) => {
      t.is(method, 'tailLogMulti', 'should call tailLogMulti')
      return []
    }
  )
  const mockReq = createMockReq()

  const result = await tailLogMultiRoute(mockCtx, mockReq, {})

  t.ok(Array.isArray(result), 'should return array')

  t.pass()
})

test('tailLogMultiRoute - with keys parameter', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async (key, method, query) => {
      t.ok(Array.isArray(query.keys), 'should parse keys as array')
      return []
    }
  )
  const mockReq = createMockReq({ keys: '["key1","key2"]' })

  await tailLogMultiRoute(mockCtx, mockReq, {})

  t.pass()
})

test('tailLogMultiRoute - with invalid keys (not array)', async (t) => {
  const mockReq = createMockReq({ keys: '{"not":"array"}' })

  try {
    await tailLogMultiRoute({ conf: { orks: [] } }, mockReq, {})
    t.fail('should throw error for invalid keys')
  } catch (err) {
    t.is(err.message, 'ERR_KEYS_INVALID_ARRAY', 'should throw ERR_KEYS_INVALID_ARRAY')
  }

  t.pass()
})

test('tailLogMultiRoute - with fields and aggrFields', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async (key, method, query) => {
      t.ok(query.fields, 'should parse fields')
      t.ok(query.aggrFields, 'should parse aggrFields')
      return []
    }
  )
  const mockReq = createMockReq({ fields: '{"id":1}', aggrFields: '{"field1":1}' })

  await tailLogMultiRoute(mockCtx, mockReq, {})

  t.pass()
})

test('tailLogMultiRoute - with invalid aggrTimes', async (t) => {
  const mockReq = createMockReq({ aggrTimes: '{"not":"array"}' })

  try {
    await tailLogMultiRoute({ conf: { orks: [] } }, mockReq, {})
    t.fail('should throw error for invalid aggrTimes')
  } catch (err) {
    t.is(err.message, 'ERR_AGGRTIMES_INVALID_ARRAY', 'should throw ERR_AGGRTIMES_INVALID_ARRAY')
  }

  t.pass()
})

test('tailLogRangeAggrRoute - basic functionality', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async (key, method, query) => {
      t.is(method, 'tailLogCustomRangeAggr', 'should call tailLogCustomRangeAggr')
      return []
    }
  )
  const mockReq = createMockReq()

  const result = await tailLogRangeAggrRoute(mockCtx, mockReq, {})

  t.ok(Array.isArray(result), 'should return array')

  t.pass()
})

test('getHistoryLogRoute - basic functionality', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [
      { rpcPublicKey: 'key1' },
      { rpcPublicKey: 'key2' }
    ],
    async (key, method, query) => {
      t.is(method, 'getHistoricalLogs', 'should call getHistoricalLogs')
      return [{ id: 1 }]
    }
  )
  const mockReq = createMockReq()

  const result = await getHistoryLogRoute(mockCtx, mockReq)

  t.ok(Array.isArray(result), 'should return array')
  t.is(result.length, 2, 'should merge logs')

  t.pass()
})

test('getHistoryLogRoute - with fields parameter', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async (key, method, query) => {
      t.ok(query.fields, 'should parse fields')
      return []
    }
  )
  const mockReq = createMockReq({ fields: '{"id":1}' })

  await getHistoryLogRoute(mockCtx, mockReq)

  t.pass()
})

test('getHistoryLogRoute - with query parameter', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async (key, method, query) => {
      t.ok(query.query, 'should parse query')
      return []
    }
  )
  const mockReq = createMockReq({ query: '{"id":1}' })

  await getHistoryLogRoute(mockCtx, mockReq)

  t.pass()
})

const DAY_MS = 24 * 60 * 60 * 1000
const END = 1785331176210

test('tailLogRoute - rejects a range that would exceed the row limit', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => [])
  // a year of 5-minute buckets is ~105k rows, past TAIL_LOG_MAX_ROWS
  const mockReq = createMockReq({ key: 'stat-5m', start: END - 365 * DAY_MS, end: END })

  await t.exception(
    tailLogRoute(mockCtx, mockReq, {}),
    /ERR_RANGE_TOO_LARGE/,
    'should reject before hitting the data layer'
  )
})

test('tailLogRoute - allows the same range at a coarser bucket', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => [])
  // the same year at 3-hour buckets is ~2.9k rows
  const mockReq = createMockReq({ key: 'stat-3h', start: END - 365 * DAY_MS, end: END })

  await tailLogRoute(mockCtx, mockReq, {})

  t.pass()
})

test('tailLogRoute - allows the widest range the export ladder asks for', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => [])
  // the export coarsens to fit its own 8640-row budget, which both of these hit
  // exactly: 30 days of stat-5m, and 6 days of stat-1m on a 1-minute site
  await tailLogRoute(
    mockCtx,
    createMockReq({ key: 'stat-5m', start: END - 30 * DAY_MS, end: END }),
    {}
  )
  await tailLogRoute(
    mockCtx,
    createMockReq({ key: 'stat-1m', start: END - 6 * DAY_MS, end: END }),
    {}
  )

  t.pass()
})

test('tailLogRoute - rejects 30 days of 1-minute buckets', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => [])
  // 43.2k rows, well past the budget. No caller asks for this: the export's
  // ladder is already on stat-5m by day 7, which is what the budget is sized to.
  const mockReq = createMockReq({ key: 'stat-1m', start: END - 30 * DAY_MS, end: END })

  await t.exception(
    tailLogRoute(mockCtx, mockReq, {}),
    /ERR_RANGE_TOO_LARGE/,
    'should reject a limitless month of the finest bucket'
  )
})

test('tailLogRoute - skips the check for stat-rtd, non-stat keys and open ranges', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => [])

  // stat-rtd is the latest sample per thing, not a series, so a range does not
  // size it; non-stat keys are not the guard's business; an open range has
  // nothing to size at all
  await tailLogRoute(
    mockCtx,
    createMockReq({ key: 'stat-rtd', start: END - 365 * DAY_MS, end: END }),
    {}
  )
  await tailLogRoute(
    mockCtx,
    createMockReq({ key: 'audit-log', start: END - 365 * DAY_MS, end: END }),
    {}
  )
  await tailLogRoute(mockCtx, createMockReq({ key: 'stat-5m' }), {})

  t.pass()
})

test('tailLogRoute - range-checks every fixed-width stat key, not just three', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => [])

  // stat-20s, stat-30m and stat-1D used to have no bucket width, so the guard
  // failed open on them: a limitless year of stat-20s is ~1.58M buckets
  await t.exception(
    tailLogRoute(
      mockCtx,
      createMockReq({ key: 'stat-20s', start: END - 365 * DAY_MS, end: END }),
      {}
    ),
    /ERR_RANGE_TOO_LARGE/,
    'should reject a limitless year of the finest bucket'
  )
  await t.exception(
    tailLogRoute(
      mockCtx,
      createMockReq({ key: 'stat-30m', start: END - 365 * DAY_MS, end: END }),
      {}
    ),
    /ERR_RANGE_TOO_LARGE/,
    'a year of 30-minute buckets is 17.5k rows, over the budget'
  )

  // and still admit the ranges those keys can serve: 9000 buckets of stat-20s is
  // 50 hours, and a year of stat-1D is 365 rows
  await tailLogRoute(
    mockCtx,
    createMockReq({ key: 'stat-20s', start: END - DAY_MS, end: END }),
    {}
  )
  await tailLogRoute(
    mockCtx,
    createMockReq({ key: 'stat-1D', start: END - 365 * DAY_MS, end: END }),
    {}
  )

  t.pass()
})

test('tailLogRoute - fails closed on a stat key with no known bucket width', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => [])
  // a stat key added upstream without a width in TAIL_LOG_BUCKET_MS must be
  // rejected rather than waved through as effectively unbounded
  const mockReq = createMockReq({ key: 'stat-10s', start: END - 365 * DAY_MS, end: END })

  await t.exception(
    tailLogRoute(mockCtx, mockReq, {}),
    /ERR_KEY_NOT_RANGE_CHECKABLE/,
    'should reject an unrecognised stat key it cannot size'
  )
})

test('tailLogRoute - an unsizeable stat key is still allowed when bounded by a limit', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => [])
  const mockReq = createMockReq({
    key: 'stat-10s',
    start: END - 365 * DAY_MS,
    end: END,
    limit: 288
  })

  await tailLogRoute(mockCtx, mockReq, {})

  t.pass()
})

test('tailLogMultiRoute - rejects when any requested key exceeds the row limit', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => [])
  const mockReq = createMockReq({
    keys: JSON.stringify([
      { key: 'stat-3h', type: 'container', tag: 't-container' },
      { key: 'stat-5m', type: 'miner', tag: 't-miner' }
    ]),
    start: END - 365 * DAY_MS,
    end: END
  })

  await t.exception(
    tailLogMultiRoute(mockCtx, mockReq, {}),
    /ERR_RANGE_TOO_LARGE/,
    'should reject on the finest requested key'
  )
})

test('tailLogRoute - allows a long range when the client bounds it with a limit', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => [])
  // the chart paths always send a limit, so the response is already bounded
  const mockReq = createMockReq({
    key: 'stat-5m',
    start: END - 365 * DAY_MS,
    end: END,
    limit: 288
  })

  await tailLogRoute(mockCtx, mockReq, {})

  t.pass()
})
