'use strict'

const test = require('brittle')
const { toCsvStream, toJsonStream } = require('../../../workers/lib/server/lib/export/serializers')

async function drain (stream) {
  let out = ''
  for await (const chunk of stream) out += chunk
  return out
}

async function * rowsFrom (rows) {
  for (const row of rows) yield row
}

test('toCsvStream renders header and quoted records', async (t) => {
  const csv = await drain(toCsvStream(rowsFrom([
    { id: 'm-1', status: 'mining', powerW: 3500 },
    { id: 'm-2', status: 'sleeping', powerW: 12 }
  ]), ['id', 'status', 'powerW']))

  t.is(csv, 'id,status,powerW\n"m-1","mining","3500"\n"m-2","sleeping","12"')
})

test('toCsvStream derives columns from the first row when not fixed', async (t) => {
  const csv = await drain(toCsvStream(rowsFrom([
    { time: '01-01-2026 00:00:00', 'Status miner-1': 'mining' },
    { time: '01-01-2026 00:05:00', 'Status miner-1': 'sleeping', extra: 'dropped' }
  ]), null))

  const lines = csv.split('\n')
  t.is(lines[0], 'time,Status miner-1')
  t.is(lines[2], '"01-01-2026 00:05:00","sleeping"')
})

test('toCsvStream escaping matches the UI collectionToCSV dialect', async (t) => {
  const csv = await drain(toCsvStream(rowsFrom([{
    quoted: 'say "hi"',
    zero: 0,
    missing: undefined,
    list: ['a', 'b'],
    objects: [{ code: 'X', level: 2 }],
    nested: { k: 'v' }
  }]), ['quoted', 'zero', 'missing', 'list', 'objects', 'nested']))

  const record = csv.split('\n')[1]
  t.is(record, '"say ""hi""","","","a; b","{code: X, level: 2}","{k: v}"')
})

test('toCsvStream emits only the header for fixed columns with no rows', async (t) => {
  const csv = await drain(toCsvStream(rowsFrom([]), ['id', 'status']))
  t.is(csv, 'id,status')
})

test('toJsonStream wraps rows under the root key with meta first', async (t) => {
  const out = await drain(toJsonStream(rowsFrom([{ id: 'm-1' }, { id: 'm-2' }]), {
    rootKey: 'miners',
    meta: { dateExported: '2026-01-01T00:00:00.000Z' }
  }))

  const parsed = JSON.parse(out)
  t.is(parsed.dateExported, '2026-01-01T00:00:00.000Z')
  t.alike(parsed.miners, [{ id: 'm-1' }, { id: 'm-2' }])
  t.ok(out.startsWith('{"dateExported"'))
})

test('toJsonStream works without meta', async (t) => {
  const out = await drain(toJsonStream(rowsFrom([{ a: 1 }]), { rootKey: 'logs' }))
  t.alike(JSON.parse(out), { logs: [{ a: 1 }] })
})
