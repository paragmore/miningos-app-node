'use strict'

const test = require('brittle')
const {
  getAutoPoolRebates,
  combinePoolRebates,
  getCombinedPoolRebates,
  updateAutoPoolRebate,
  deleteAutoPoolRebate
} = require('../../../workers/lib/server/handlers/rebates.utils')
const { setGlobalData, getGlobalData } = require('../../../workers/lib/server/handlers/global.handlers')
const {
  GLOBAL_DATA_TYPES,
  MEMPOOL_EXT_DATA_KEYS,
  RPC_METHODS,
  WORKER_TYPES
} = require('../../../workers/lib/constants')
const GlobalDataLib = require('../../../workers/lib/globalData')

const TXID_A = 'a'.repeat(64)
const TXID_B = 'b'.repeat(64)
const TXID_C = 'c'.repeat(64)

const makeCtx = ({ manual = [], autoResults = [[]], setResults = [[true]] } = {}) => ({
  requests: [],
  setRequests: [],
  globalDataLib: {
    writes: [],
    async getGlobalData () { return manual },
    async setGlobalData (data, type) {
      this.writes.push({ data, type })
      return true
    },
    filterData: GlobalDataLib.prototype.filterData
  },
  dataProxy: {
    async requestData (method, payload) {
      ctxRef.requests.push({ method, payload })
      if (autoResults instanceof Error) throw autoResults
      return autoResults
    },
    async requestDataMap (method, payload) {
      ctxRef.setRequests.push({ method, payload })
      if (setResults instanceof Error) throw setResults
      return setResults
    }
  }
})
let ctxRef

const ctx = (opts) => {
  ctxRef = makeCtx(opts)
  return ctxRef
}

test('getAutoPoolRebates flattens worker replies and stamps auto', async (t) => {
  const c = ctx({
    autoResults: [
      [{ txid: TXID_A, ts: 1 }],
      { error: 'ERR_X' },
      [{ txid: TXID_B, ts: 2, source: 'manual' }]
    ]
  })

  const rows = await getAutoPoolRebates(c, { start: 10, end: 20 })

  t.alike(rows.map((r) => [r.txid, r.source]), [[TXID_A, 'auto'], [TXID_B, 'auto']])
  const { method, payload } = c.requests[0]
  t.is(method, RPC_METHODS.GET_WRK_EXT_DATA)
  t.is(payload.type, WORKER_TYPES.MEMPOOL)
  t.alike(payload.query, { key: MEMPOOL_EXT_DATA_KEYS.POOL_REBATES, start: 10, end: 20 })
})

test('combinePoolRebates keeps manual winners and collapses repeated auto rows', (t) => {
  const manual = [
    { ts: 1, txid: TXID_A, amountBTC: 9, source: 'manual' },
    { ts: 2, amountBTC: 1, source: 'manual' }
  ]
  const auto = [
    { ts: 3, txid: TXID_A, amountBTC: 1, source: 'auto' },
    { ts: 4, txid: TXID_B, amountBTC: 2, source: 'auto' },
    { ts: 4, txid: TXID_B, amountBTC: 2, source: 'auto' }
  ]

  const combined = combinePoolRebates(manual, auto)

  t.is(combined.length, 3)
  t.is(combined.find((r) => r.txid === TXID_A).amountBTC, 9, 'manual row wins on txid clash')
  t.is(combined.filter((r) => r.txid === TXID_B).length, 1)
})

test('getCombinedPoolRebates degrades to manual-only when the worker fails', async (t) => {
  const manual = [{ ts: 1, txid: TXID_A, source: 'manual' }]
  const c = ctx({ manual, autoResults: new Error('ERR_NET') })

  const combined = await getCombinedPoolRebates(c, { start: 0, end: 10 })

  t.alike(combined, manual)
})

test('updateAutoPoolRebate forwards the edit and surfaces worker errors', async (t) => {
  const c = ctx({ setResults: [[true]] })

  await updateAutoPoolRebate(c, { txid: TXID_A.toUpperCase(), ts: 5, amountBTC: 2, sender: 's', receiver: 'r' })

  const { method, payload } = c.setRequests[0]
  t.is(method, RPC_METHODS.SET_WRK_EXT_DATA)
  t.is(payload.key, MEMPOOL_EXT_DATA_KEYS.POOL_REBATES_UPDATE)
  t.alike(payload.value, { txid: TXID_A, ts: 5, amountBTC: 2, sender: 's', receiver: 'r' })

  const failing = ctx({ setResults: [[{ error: 'ERR_REBATE_NOT_FOUND' }]] })
  await t.exception(
    () => updateAutoPoolRebate(failing, { txid: TXID_A, ts: 5, amountBTC: 2 }),
    /ERR_REBATE_NOT_FOUND/
  )
})

test('deleteAutoPoolRebate forwards the tombstone write', async (t) => {
  const c = ctx({ setResults: [[true]] })

  await deleteAutoPoolRebate(c, TXID_A)

  const { payload } = c.setRequests[0]
  t.is(payload.key, MEMPOOL_EXT_DATA_KEYS.POOL_REBATES_DELETE)
  t.alike(payload.value, { txid: TXID_A })
})

test('setGlobalData routes auto-row edits to the mempool worker', async (t) => {
  const c = ctx({ setResults: [[true]] })

  await setGlobalData(c, {
    body: { data: { source: 'auto', txid: TXID_A, ts: 5, amountBTC: 2 } },
    query: { type: GLOBAL_DATA_TYPES.POOL_REBATES }
  })

  t.is(c.setRequests.length, 1)
  t.is(c.setRequests[0].payload.key, MEMPOOL_EXT_DATA_KEYS.POOL_REBATES_UPDATE)
  t.is(c.globalDataLib.writes.length, 0)
})

test('setGlobalData deletes the manual row and tombstones the txid', async (t) => {
  const c = ctx({ setResults: [[true]] })

  await setGlobalData(c, {
    body: { data: { ts: 5, txid: TXID_A, source: 'auto', remove: true } },
    query: { type: GLOBAL_DATA_TYPES.POOL_REBATES }
  })

  t.alike(c.globalDataLib.writes[0], { data: { ts: 5, remove: true }, type: GLOBAL_DATA_TYPES.POOL_REBATES })
  t.is(c.setRequests[0].payload.key, MEMPOOL_EXT_DATA_KEYS.POOL_REBATES_DELETE)
})

test('setGlobalData delete without txid stays local', async (t) => {
  const c = ctx()

  await setGlobalData(c, {
    body: { data: { ts: 5, remove: true } },
    query: { type: GLOBAL_DATA_TYPES.POOL_REBATES }
  })

  t.is(c.globalDataLib.writes.length, 1)
  t.is(c.setRequests.length, 0)
})

test('setGlobalData rejects a manual txid already synced as auto', async (t) => {
  const c = ctx({ autoResults: [[{ txid: TXID_B, ts: 2 }]] })

  await t.exception(
    () => setGlobalData(c, {
      body: { data: { ts: 5, amountBTC: 1, txid: TXID_B.toUpperCase() } },
      query: { type: GLOBAL_DATA_TYPES.POOL_REBATES }
    }),
    /ERR_DUPLICATE_TXID/
  )
  t.is(c.globalDataLib.writes.length, 0)
})

test('setGlobalData lets manual writes through when the worker is unreachable', async (t) => {
  const c = ctx({ autoResults: new Error('ERR_NET') })

  await setGlobalData(c, {
    body: { data: { ts: 5, amountBTC: 1, txid: TXID_C } },
    query: { type: GLOBAL_DATA_TYPES.POOL_REBATES }
  })

  t.is(c.globalDataLib.writes.length, 1)
})

test('getGlobalData serves the combined, filtered rebate list', async (t) => {
  const manual = [{ ts: 15, txid: TXID_A, source: 'manual' }]
  const c = ctx({ manual, autoResults: [[{ txid: TXID_B, ts: 5 }, { txid: TXID_C, ts: 25 }]] })

  const rows = await getGlobalData(c, {
    query: { type: GLOBAL_DATA_TYPES.POOL_REBATES, gte: 10, lte: 20 }
  })

  t.alike(rows.map((r) => r.txid), [TXID_A], 'range bounds apply to the combined set')
})

test('getGlobalData paginates, sorts and projects the combined rebate list', async (t) => {
  const manual = [{ ts: 100, txid: TXID_A, amountBTC: 1, source: 'manual' }]
  const auto = [
    { txid: TXID_B, ts: 300, amountBTC: 3 },
    { txid: TXID_C, ts: 200, amountBTC: 2 }
  ]
  const c = ctx({ manual, autoResults: [auto] })
  const base = { type: GLOBAL_DATA_TYPES.POOL_REBATES, sort: '{"ts":-1}' }

  const page1 = await getGlobalData(c, { query: { ...base, limit: 2 } })
  t.alike(page1.map((r) => r.ts), [300, 200])

  const page2 = await getGlobalData(c, { query: { ...base, offset: 2, limit: 2 } })
  t.alike(page2.map((r) => r.ts), [100])

  const projected = await getGlobalData(c, {
    query: { ...base, fields: '{"txid":1,"amountBTC":1}', limit: 1 }
  })
  t.alike(projected, [{ txid: TXID_B, amountBTC: 3 }], 'projection drops unselected fields')

  const queried = await getGlobalData(c, {
    query: { ...base, query: '{"amountBTC":{"$gte":3}}' }
  })
  t.alike(queried.map((r) => r.txid), [TXID_B])

  const grouped = await getGlobalData(c, {
    query: { ...base, groupBy: 'source' }
  })
  t.alike(Object.keys(grouped).sort(), ['auto', 'manual'])
  t.is(grouped.auto.length, 2)
})
