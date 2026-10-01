'use strict'

const test = require('brittle')
const { getGlobalConfig, setGlobalConfig, getFeatureConfig, getFeatures, setFeatures, getGlobalData, setGlobalData } = require('../../../workers/lib/server/handlers/global.handlers')
const { GLOBAL_DATA_TYPES, LOCKED_TIMEZONE_DEFAULT } = require('../../../workers/lib/constants')
const { withDataProxy } = require('../helpers/mockHelpers')

test('getGlobalConfig - with fields query param', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [
        { rpcPublicKey: 'key1' },
        { rpcPublicKey: 'key2' }
      ]
    },
    net_r0: {
      jRequest: async () => ({ config: 'test' })
    }
  })

  const mockReq = {
    query: {
      fields: '{"name":1,"value":1}'
    }
  }

  const result = await getGlobalConfig(mockCtx, mockReq, {})
  t.ok(Array.isArray(result), 'should return array')
  t.is(result.length, 2, 'should return results for all orks')
  t.pass()
})

test('getGlobalConfig - without fields query param', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [
        { rpcPublicKey: 'key1' }
      ]
    },
    net_r0: {
      jRequest: async () => ({ config: 'test' })
    }
  })

  const mockReq = {
    query: {}
  }

  const result = await getGlobalConfig(mockCtx, mockReq, {})
  t.ok(Array.isArray(result), 'should return array')
  t.pass()
})

test('setGlobalConfig - basic functionality', async (t) => {
  const mockCtx = withDataProxy({
    conf: {
      orks: [
        { rpcPublicKey: 'key1' },
        { rpcPublicKey: 'key2' }
      ]
    },
    net_r0: {
      jRequest: async () => ({ success: true })
    }
  })

  const mockReq = {
    body: {
      data: { setting: 'value' }
    }
  }

  const result = await setGlobalConfig(mockCtx, mockReq, {})
  t.ok(Array.isArray(result), 'should return array')
  t.is(result.length, 2, 'should return results for all orks')
  t.pass()
})

test('getFeatureConfig - returns feature config from context', async (t) => {
  const mockCtx = {
    globalDataLib: { getGlobalData: async () => ({}) },
    conf: {
      featureConfig: { feature1: true, feature2: false }
    }
  }

  const result = await getFeatureConfig(mockCtx)
  t.ok(typeof result === 'object', 'should return object')
  t.is(result.feature1, true, 'should return feature config')
  t.pass()
})

test('getFeatureConfig - passes through a configured lockedTimezone', async (t) => {
  const mockCtx = {
    globalDataLib: { getGlobalData: async () => ({}) },
    conf: {
      featureConfig: { lockedTimezone: 'America/Campo_Grande' }
    }
  }

  const result = await getFeatureConfig(mockCtx)
  t.is(result.lockedTimezone, 'America/Campo_Grande')
  t.pass()
})

test('getFeatureConfig - defaults lockedTimezone when common.json omits it', async (t) => {
  const mockCtx = {
    globalDataLib: { getGlobalData: async () => ({}) },
    conf: {
      featureConfig: { feature1: true }
    }
  }

  const result = await getFeatureConfig(mockCtx)
  t.is(result.lockedTimezone, LOCKED_TIMEZONE_DEFAULT)
  t.is(result.feature1, true, 'other feature flags still pass through')
  t.pass()
})

test('getFeatureConfig - defaults lockedTimezone when featureConfig is missing entirely', async (t) => {
  const mockCtx = { globalDataLib: { getGlobalData: async () => ({}) }, conf: {} }

  const result = await getFeatureConfig(mockCtx)
  t.is(result.lockedTimezone, LOCKED_TIMEZONE_DEFAULT)
  t.pass()
})

test('getFeatureConfig - merges feature flags under site config', async (t) => {
  const mockCtx = {
    globalDataLib: {
      getGlobalData: async (req) => {
        t.is(req.type, GLOBAL_DATA_TYPES.FEATURES)
        return { inventory: true, flagOnly: true }
      }
    },
    conf: { featureConfig: { inventory: false } }
  }

  const result = await getFeatureConfig(mockCtx)
  t.is(result.flagOnly, true, 'flag-only keys are included')
  t.is(result.inventory, false, 'site config wins on conflicts')
})

test('getFeatures - returns features from globalDataLib', async (t) => {
  const mockCtx = {
    globalDataLib: {
      getGlobalData: async (req) => {
        t.is(req.type, GLOBAL_DATA_TYPES.FEATURES, 'should request features type')
        return { feature1: true, feature2: false }
      }
    }
  }

  const result = await getFeatures(mockCtx)
  t.ok(typeof result === 'object', 'should return object')
  t.is(result.feature1, true, 'should return features')
  t.pass()
})

test('setFeatures - sets features via globalDataLib', async (t) => {
  const mockCtx = {
    globalDataLib: {
      setGlobalData: async (data, type) => {
        t.is(type, GLOBAL_DATA_TYPES.FEATURES, 'should set features type')
        t.is(data.feature1, true, 'should set correct data')
        return true
      }
    }
  }

  const mockReq = {
    body: {
      data: { feature1: true, feature2: false }
    }
  }

  const result = await setFeatures(mockCtx, mockReq)
  t.is(result, true, 'should return true')
  t.pass()
})

test('getGlobalData - basic functionality', async (t) => {
  const mockCtx = {
    globalDataLib: {
      getGlobalData: async (req) => {
        t.is(req.type, 'test-type', 'should pass type')
        t.ok(req.range, 'should pass range')
        t.ok(req.opts, 'should pass opts')
        return [{ id: 1, data: 'test' }]
      }
    }
  }

  const mockReq = {
    query: {
      type: 'test-type',
      gt: '100',
      gte: '200',
      lt: '300',
      lte: '400',
      limit: '10',
      query: '{"id":1}',
      sort: '{"id":1}',
      fields: '{"id":1,"data":1}',
      offset: '0',
      groupBy: 'id'
    }
  }

  const result = await getGlobalData(mockCtx, mockReq)
  t.ok(Array.isArray(result), 'should return array')
  t.pass()
})

test('getGlobalData - without optional params', async (t) => {
  const mockCtx = {
    globalDataLib: {
      getGlobalData: async (req) => {
        t.is(req.type, 'test-type', 'should pass type')
        return []
      }
    }
  }

  const mockReq = {
    query: {
      type: 'test-type'
    }
  }

  const result = await getGlobalData(mockCtx, mockReq)
  t.ok(Array.isArray(result), 'should return array')
  t.pass()
})

test('setGlobalData - basic functionality', async (t) => {
  const mockCtx = {
    globalDataLib: {
      setGlobalData: async (data, type) => {
        t.is(type, 'test-type', 'should pass type')
        t.is(data.key, 'value', 'should pass data')
        return true
      }
    }
  }

  const mockReq = {
    body: {
      data: { key: 'value' }
    },
    query: {
      type: 'test-type'
    }
  }

  const result = await setGlobalData(mockCtx, mockReq)
  t.is(result, true, 'should return true')
  t.pass()
})

// A rebate is worth what BTC cost when it arrived, so that price is captured on
// the way in rather than re-derived from a daily price whenever it is read back.
const { priceBucket } = require('../../../workers/lib/server/handlers/finance.utils')

const rebateCtx = (jRequest) => withDataProxy({
  conf: { orks: [{ rpcPublicKey: 'key1' }] },
  net_r0: { jRequest },
  globalDataLib: { setGlobalData: async (data) => data }
})

test('setGlobalData - a rebate is stored with the BTC price it was received at', async (t) => {
  const ts = Date.UTC(2024, 0, 15, 10, 32)
  const bucketTs = priceBucket(ts)

  const stored = await setGlobalData(
    rebateCtx(async (_key, method, payload) => {
      if (method === 'getWrkExtData' && payload.query.key === 'PRICE_AT_TIMESTAMPS') {
        t.alike(payload.query.timestamps, [bucketTs], 'asks for the bucket the rebate landed in')
        return { prices: { [bucketTs]: 42000 }, missing: [] }
      }
      return {}
    }),
    { body: { data: { ts, amountBTC: 0.5 } }, query: { type: GLOBAL_DATA_TYPES.POOL_REBATES } }
  )

  t.is(stored.priceUSD, 42000)
})

test('setGlobalData - a rebate with no recorded price is still stored', async (t) => {
  const ts = Date.UTC(2024, 0, 15, 10, 32)

  const stored = await setGlobalData(
    rebateCtx(async () => ({ prices: {}, missing: [priceBucket(ts)] })),
    { body: { data: { ts, amountBTC: 0.5 } }, query: { type: GLOBAL_DATA_TYPES.POOL_REBATES } }
  )

  t.absent(stored.priceUSD, 'a backdated rebate simply has no price yet')
  t.is(stored.amountBTC, 0.5, 'and the entry itself is never lost over it')
})

test('setGlobalData - an unreachable price worker does not fail the rebate write', async (t) => {
  const ts = Date.UTC(2024, 0, 15, 10, 32)

  const stored = await setGlobalData(
    rebateCtx(async () => { throw new Error('CHANNEL_CLOSED') }),
    { body: { data: { ts, amountBTC: 0.5 } }, query: { type: GLOBAL_DATA_TYPES.POOL_REBATES } }
  )

  t.is(stored.amountBTC, 0.5)
  t.absent(stored.priceUSD)
})

test('setGlobalData - a client-sent price is discarded, never trusted', async (t) => {
  const ts = Date.UTC(2024, 0, 15, 10, 32)

  const stored = await setGlobalData(
    rebateCtx(async () => ({ prices: {}, missing: [] })),
    { body: { data: { ts, amountBTC: 0.5, priceUSD: 1 } }, query: { type: GLOBAL_DATA_TYPES.POOL_REBATES } }
  )

  t.absent(stored.priceUSD, 'the price is derived server-side or absent')
})

test('setGlobalData - removing a rebate skips the price lookup', async (t) => {
  let asked = false

  const result = await setGlobalData(
    rebateCtx(async () => { asked = true; return {} }),
    { body: { data: { ts: 1700006400000, remove: true } }, query: { type: GLOBAL_DATA_TYPES.POOL_REBATES } }
  )

  t.absent(asked, 'a delete needs no price')
  t.is(result, true)
})
