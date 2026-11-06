'use strict'

const test = require('brittle')
const { RealtimeSeries } = require('../../../workers/lib/server/lib/realtimeSeries')

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN

function sourceOf (rows) {
  const calls = []
  const fetch = async (start, end) => {
    calls.push([start, end])
    return rows.filter(row => row.ts >= start && row.ts <= end)
  }
  return { calls, fetch }
}

test('RealtimeSeries loads the whole retention in chunks on first read', async (t) => {
  const now = 10 * HOUR
  const rows = Array.from({ length: 10 }, (_, i) => ({ ts: now - i * HOUR + SEC, v: i })).reverse()
  const src = sourceOf(rows)
  const series = new RealtimeSeries({ retentionMs: 6 * HOUR, refreshMs: 5 * SEC, chunkMs: 2 * HOUR, fetch: src.fetch })

  const log = await series.read(null, now)

  t.alike(src.calls, [
    [4 * HOUR + 1, 6 * HOUR],
    [6 * HOUR + 1, 8 * HOUR],
    [8 * HOUR + 1, 10 * HOUR]
  ])
  t.alike(log.map(row => row.v), [6, 5, 4, 3, 2, 1])
})

test('RealtimeSeries tops up incrementally and drops entries past retention', async (t) => {
  const rows = [{ ts: 1 * MIN }, { ts: 2 * MIN }]
  const src = sourceOf(rows)
  const series = new RealtimeSeries({ retentionMs: 3 * MIN, refreshMs: SEC, chunkMs: HOUR, fetch: src.fetch })

  await series.read(null, 3 * MIN)
  rows.push({ ts: 4 * MIN })
  const log = await series.read(null, 4 * MIN + 30 * SEC)

  t.alike(src.calls.at(-1), [2 * MIN + 1, 4 * MIN + 30 * SEC])
  t.alike(log.map(row => row.ts), [2 * MIN, 4 * MIN])
  t.alike(series.entries.map(row => row.ts), [2 * MIN, 4 * MIN])
})

test('RealtimeSeries re-reads a refetch window and replaces updated rows', async (t) => {
  const rows = [{ ts: 1 * MIN, v: null }]
  const src = sourceOf(rows)
  const series = new RealtimeSeries({ retentionMs: HOUR, refreshMs: SEC, chunkMs: HOUR, refetchMs: 3 * MIN, fetch: src.fetch })

  await series.read(null, 2 * MIN)
  rows[0] = { ts: 1 * MIN, v: 5 }
  rows.push({ ts: 2 * MIN, v: 6 })
  const log = await series.read(null, 3 * MIN)

  t.alike(log, [{ ts: 1 * MIN, v: 5 }, { ts: 2 * MIN, v: 6 }])
})

test('RealtimeSeries serves cached entries between refreshes and filters by since', async (t) => {
  const rows = [{ ts: 1 * SEC }, { ts: 2 * SEC }, { ts: 3 * SEC }]
  const src = sourceOf(rows)
  const series = new RealtimeSeries({ retentionMs: HOUR, refreshMs: 10 * SEC, chunkMs: HOUR, fetch: src.fetch })

  await series.read(null, 4 * SEC)
  const log = await series.read(2 * SEC, 5 * SEC)

  t.is(src.calls.length, 1)
  t.alike(log, [{ ts: 3 * SEC }])
})

test('RealtimeSeries shares one in-flight refresh between concurrent readers', async (t) => {
  let release
  let calls = 0
  const series = new RealtimeSeries({
    retentionMs: HOUR,
    refreshMs: SEC,
    chunkMs: HOUR,
    fetch: () => {
      calls++
      return new Promise(resolve => { release = () => resolve([{ ts: 5 }]) })
    }
  })

  const reads = [series.read(null, 10), series.read(null, 10), series.read(null, 10)]
  release()
  const logs = await Promise.all(reads)

  t.is(calls, 1)
  t.alike(logs, [[{ ts: 5 }], [{ ts: 5 }], [{ ts: 5 }]])
})

test('RealtimeSeries keeps serving stale data when a top-up fails', async (t) => {
  let fail = false
  const series = new RealtimeSeries({
    retentionMs: HOUR,
    refreshMs: SEC,
    chunkMs: HOUR,
    fetch: async () => {
      if (fail) throw new Error('ERR_ORK_DOWN')
      return [{ ts: 5 }]
    }
  })

  await series.read(null, 10)
  fail = true
  t.alike(await series.read(null, 10 * SEC), [{ ts: 5 }])
})

test('RealtimeSeries surfaces a failed first load', async (t) => {
  const series = new RealtimeSeries({
    retentionMs: HOUR,
    refreshMs: SEC,
    chunkMs: HOUR,
    fetch: async () => { throw new Error('ERR_ORK_DOWN') }
  })

  await t.exception(() => series.read(null, 10), /ERR_ORK_DOWN/)
})
