'use strict'

const test = require('brittle')
const utilsStore = require('@tetherto/hp-svc-facs-store/utils')
const { GLOBAL_DATA_TYPES, POOL_REBATE_SOURCES } = require('../../workers/lib/constants')
const GlobalDataLib = require('../../workers/lib/globalData')

const TXID_A = 'a'.repeat(64)
const TXID_B = 'b'.repeat(64)

const makeBee = () => {
  const subs = new Map()
  return {
    sub: (name) => {
      if (!subs.has(name)) {
        const rows = new Map()
        subs.set(name, {
          rows,
          get: async (key) => {
            const k = key.toString('hex')
            return rows.has(k) ? { value: rows.get(k) } : null
          },
          put: async (key, value) => { rows.set(key.toString('hex'), value) },
          del: async (key) => { rows.delete(key.toString('hex')) },
          createReadStream: () => (async function * () {
            for (const value of rows.values()) yield { value: Buffer.from(value) }
          })()
        })
      }
      return subs.get(name)
    }
  }
}

const makeLib = () => {
  const bee = makeBee()
  return { bee, lib: new GlobalDataLib(bee, 'test-site') }
}

const readRebates = async (lib) =>
  lib.queryGlobalData(lib._globalDataBee.sub(GLOBAL_DATA_TYPES.POOL_REBATES))

test('setPoolRebatesData stamps manual source and normalizes txid', async (t) => {
  const { lib } = makeLib()

  await lib.setPoolRebatesData({
    ts: 1000,
    amountBTC: 0.5,
    txid: TXID_A.toUpperCase(),
    sender: 'bc1qsender',
    receiver: 'bc1qreceiver',
    source: 'auto'
  })

  const rows = await readRebates(lib)
  t.is(rows.length, 1)
  t.alike(rows[0], {
    site: 'test-site',
    ts: 1000,
    amountBTC: 0.5,
    txid: TXID_A,
    sender: 'bc1qsender',
    receiver: 'bc1qreceiver',
    source: POOL_REBATE_SOURCES.MANUAL
  })
})

test('setPoolRebatesData rejects malformed txids', async (t) => {
  const { lib } = makeLib()
  await t.exception(
    () => lib.setPoolRebatesData({ ts: 1000, amountBTC: 1, txid: 'not-a-txid' }),
    /ERR_INVALID_TXID/
  )
})

test('setPoolRebatesData rejects a txid already stored on another row', async (t) => {
  const { lib } = makeLib()
  await lib.setPoolRebatesData({ ts: 1000, amountBTC: 1, txid: TXID_A })

  await t.exception(
    () => lib.setPoolRebatesData({ ts: 2000, amountBTC: 2, txid: TXID_A }),
    /ERR_DUPLICATE_TXID/
  )
})

test('setPoolRebatesData allows txid-less rows to repeat', async (t) => {
  const { lib } = makeLib()
  await lib.setPoolRebatesData({ ts: 1000, amountBTC: 1 })
  await lib.setPoolRebatesData({ ts: 2000, amountBTC: 1 })

  const rows = await readRebates(lib)
  t.is(rows.length, 2)
})

test('same-ts rows are kept by probing the next key', async (t) => {
  const { lib } = makeLib()
  await lib.setPoolRebatesData({ ts: 1000, amountBTC: 1, txid: TXID_A })
  await lib.setPoolRebatesData({ ts: 1000, amountBTC: 2, txid: TXID_B })

  const rows = await readRebates(lib)
  t.alike(rows.map((row) => row.ts).sort(), [1000, 1001])
  t.is(rows.length, 2)
})

test('prevTs edit moves the row', async (t) => {
  const { lib } = makeLib()
  await lib.setPoolRebatesData({ ts: 1000, amountBTC: 1, txid: TXID_A })

  await lib.setPoolRebatesData({ ts: 5000, prevTs: 1000, amountBTC: 3, txid: TXID_A })

  const rows = await readRebates(lib)
  t.is(rows.length, 1)
  t.is(rows[0].ts, 5000)
  t.is(rows[0].amountBTC, 3)
})

test('prevTs edit keeping the same ts does not trip the collision probe', async (t) => {
  const { lib } = makeLib()
  await lib.setPoolRebatesData({ ts: 1000, amountBTC: 1, txid: TXID_A })
  await lib.setPoolRebatesData({ ts: 1000, prevTs: 1000, amountBTC: 2, txid: TXID_A })

  const rows = await readRebates(lib)
  t.is(rows.length, 1)
  t.is(rows[0].ts, 1000)
  t.is(rows[0].amountBTC, 2)
})

test('prevTs edit of a missing row fails', async (t) => {
  const { lib } = makeLib()
  await t.exception(
    () => lib.setPoolRebatesData({ ts: 2000, prevTs: 1000, amountBTC: 1 }),
    /ERR_REBATE_NOT_FOUND/
  )
})

test('remove deletes the manual row at ts', async (t) => {
  const { lib } = makeLib()
  await lib.setPoolRebatesData({ ts: 1000, amountBTC: 1, txid: TXID_A })

  await lib.setPoolRebatesData({ ts: 1000, remove: true })

  t.is((await readRebates(lib)).length, 0)
})

test('rebate keys stay range-queryable by ts', async (t) => {
  const { lib } = makeLib()
  const bin = utilsStore.convIntToBin(1000)
  await lib.setPoolRebatesData({ ts: 1000, amountBTC: 1, txid: TXID_A })

  const db = lib._globalDataBee.sub(GLOBAL_DATA_TYPES.POOL_REBATES)
  const stored = await db.get(bin)
  t.ok(stored, 'row is keyed by convIntToBin(ts)')
})

test('setPoolRebatesData persists a handler-derived receipt price', async (t) => {
  const { lib } = makeLib()

  await lib.setPoolRebatesData({ ts: 1000, amountBTC: 0.5, priceUSD: 42000 })

  const [row] = await readRebates(lib)
  t.is(row.priceUSD, 42000)
})

test('an edit keeping the same ts preserves the stored receipt price', async (t) => {
  const { lib } = makeLib()
  await lib.setPoolRebatesData({ ts: 1000, amountBTC: 0.5, priceUSD: 42000 })

  // The handler could not re-derive a price (no bucket recorded), so the data
  // arrives without one; the moment is unchanged, so the old price still holds.
  await lib.setPoolRebatesData({ ts: 1000, prevTs: 1000, amountBTC: 0.75 })

  const [row] = await readRebates(lib)
  t.is(row.amountBTC, 0.75)
  t.is(row.priceUSD, 42000)
})

test('an edit moving the ts drops a price it cannot re-derive', async (t) => {
  const { lib } = makeLib()
  await lib.setPoolRebatesData({ ts: 1000, amountBTC: 0.5, priceUSD: 42000 })

  await lib.setPoolRebatesData({ ts: 2000, prevTs: 1000, amountBTC: 0.5 })

  const [row] = await readRebates(lib)
  t.is(row.ts, 2000)
  t.is(row.priceUSD, undefined, 'the old moment\'s price would be wrong for the new one')
})

test('an edit moving the ts takes a freshly derived price', async (t) => {
  const { lib } = makeLib()
  await lib.setPoolRebatesData({ ts: 1000, amountBTC: 0.5, priceUSD: 42000 })

  await lib.setPoolRebatesData({ ts: 2000, prevTs: 1000, amountBTC: 0.5, priceUSD: 43000 })

  const [row] = await readRebates(lib)
  t.is(row.priceUSD, 43000)
})
