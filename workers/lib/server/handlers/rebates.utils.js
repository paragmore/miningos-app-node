'use strict'

const {
  GLOBAL_DATA_TYPES,
  MEMPOOL_EXT_DATA_KEYS,
  POOL_REBATE_SOURCES,
  RPC_METHODS,
  WORKER_TYPES
} = require('../../constants')

// Synced rebates live in the mempool worker (it reads and stores everything
// that comes from mempool.space); app-node only stores manual entries and
// merges the two sets at read time.
async function getAutoPoolRebates (ctx, { start, end } = {}) {
  const results = await ctx.dataProxy.requestData(RPC_METHODS.GET_WRK_EXT_DATA, {
    type: WORKER_TYPES.MEMPOOL,
    query: { key: MEMPOOL_EXT_DATA_KEYS.POOL_REBATES, start, end }
  })

  const rows = []
  for (const res of Array.isArray(results) ? results : []) {
    if (Array.isArray(res)) rows.push(...res)
  }

  return rows
    .filter((row) => row && Number.isFinite(row.ts))
    .map((row) => ({ ...row, source: POOL_REBATE_SOURCES.AUTO }))
}

// A transaction paying several configured rebate addresses is synced as one
// row per (txid, receiver) - each site phase's share on its own row - so rows
// collapse on that pair, not on the txid alone, which would drop every
// address's share but one.
const rebateRowKey = (row) => `${row.txid}:${row.receiver ?? ''}`

// A manual row is a user correction and wins over the synced row it
// addresses: the same (txid, receiver) pair, or - for a manual row without a
// receiver - every row of its txid. Auto rows repeated across workers/orks
// collapse to one.
function combinePoolRebates (manual, auto) {
  const manualKeys = new Set()
  const manualTxids = new Set()
  for (const row of manual) {
    if (!row?.txid) continue
    if (row.receiver) manualKeys.add(rebateRowKey(row))
    else manualTxids.add(row.txid)
  }

  const combined = [...manual]
  const seenAuto = new Set()

  for (const row of auto) {
    if (!row?.txid || manualTxids.has(row.txid)) continue
    const key = rebateRowKey(row)
    if (manualKeys.has(key) || seenAuto.has(key)) continue
    seenAuto.add(key)
    combined.push(row)
  }

  return combined
}

async function getCombinedPoolRebates (ctx, { start, end } = {}) {
  const range = {}
  if (Number.isFinite(start)) range.gte = start
  if (Number.isFinite(end)) range.lte = end

  const manual = await ctx.globalDataLib.getGlobalData({
    type: GLOBAL_DATA_TYPES.POOL_REBATES,
    range: Object.keys(range).length ? range : undefined
  })

  // The Rebates page and the finance rollups must not die with the mempool
  // worker: a failed fetch degrades to manual-only.
  let auto = []
  try {
    auto = await getAutoPoolRebates(ctx, { start, end })
  } catch (err) {
    console.error(new Date().toISOString(), 'ERR_POOL_REBATES_AUTO_FETCH', err.message)
  }

  return combinePoolRebates(Array.isArray(manual) ? manual : [], auto)
}

// requestDataMap returns one entry per ork, each the ork's per-worker result
// array; a worker failure arrives as {error}. Success anywhere is enough -
// the write is idempotent by txid - but an error-only reply must surface.
function assertRebateWriteApplied (results) {
  const flat = (Array.isArray(results) ? results : [results]).flat(Infinity)
  if (flat.some((res) => res === true)) return true

  const failure = flat.find((res) => res?.error)
  throw new Error(failure?.error || 'ERR_REBATES_WRITE_FAILED')
}

async function updateAutoPoolRebate (ctx, data) {
  const { txid, ts, amountBTC, sender, receiver } = data
  if (!txid) throw new Error('ERR_TXID_REQUIRED')

  const results = await ctx.dataProxy.requestDataMap(RPC_METHODS.SET_WRK_EXT_DATA, {
    type: WORKER_TYPES.MEMPOOL,
    key: MEMPOOL_EXT_DATA_KEYS.POOL_REBATES_UPDATE,
    value: { txid: String(txid).toLowerCase(), ts, amountBTC, sender, receiver }
  })
  return assertRebateWriteApplied(results)
}

async function deleteAutoPoolRebate (ctx, txid) {
  if (!txid) throw new Error('ERR_TXID_REQUIRED')
  const results = await ctx.dataProxy.requestDataMap(RPC_METHODS.SET_WRK_EXT_DATA, {
    type: WORKER_TYPES.MEMPOOL,
    key: MEMPOOL_EXT_DATA_KEYS.POOL_REBATES_DELETE,
    value: { txid: String(txid).toLowerCase() }
  })
  return assertRebateWriteApplied(results)
}

module.exports = {
  getAutoPoolRebates,
  combinePoolRebates,
  getCombinedPoolRebates,
  updateAutoPoolRebate,
  deleteAutoPoolRebate
}
