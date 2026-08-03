'use strict'

const test = require('brittle')
const {
  testModuleStructure,
  testHandlerFunctions,
  testOnRequestFunctions
} = require('../helpers/routeTestHelpers')
const { ENDPOINTS, HTTP_METHODS } = require('../../../workers/lib/constants')

const ROUTES_PATH = '../../../workers/lib/server/routes/work.orders.routes'

test('work.orders.routes: module structure', (t) => {
  const routes = testModuleStructure(t, ROUTES_PATH, 'work.orders')
  testHandlerFunctions(t, routes, 'work.orders')
  testOnRequestFunctions(t, routes, 'work.orders')
})

test('work.orders.routes: registers every WO endpoint', (t) => {
  const routes = require(ROUTES_PATH)({})
  const expected = [
    { method: HTTP_METHODS.POST, url: ENDPOINTS.WORK_ORDERS },
    { method: HTTP_METHODS.GET, url: ENDPOINTS.WORK_ORDERS },
    { method: HTTP_METHODS.GET, url: ENDPOINTS.WORK_ORDER_BY_ID },
    { method: HTTP_METHODS.GET, url: ENDPOINTS.WORK_ORDER_AUDIT },
    { method: HTTP_METHODS.PATCH, url: ENDPOINTS.WORK_ORDER_BY_ID },
    { method: HTTP_METHODS.POST, url: ENDPOINTS.WORK_ORDER_CLOSE },
    { method: HTTP_METHODS.POST, url: ENDPOINTS.WORK_ORDER_CANCEL },
    { method: HTTP_METHODS.POST, url: ENDPOINTS.WORK_ORDER_REOPEN },
    { method: HTTP_METHODS.POST, url: ENDPOINTS.WORK_ORDER_ASSIGN },
    { method: HTTP_METHODS.POST, url: ENDPOINTS.WORK_ORDER_LOG },
    { method: HTTP_METHODS.GET, url: ENDPOINTS.WORK_ORDER_EXPORT },
    { method: HTTP_METHODS.GET, url: ENDPOINTS.WORK_ORDER_EXPORT_RMA }
  ]
  for (const e of expected) {
    const found = routes.find(r => r.method === e.method && r.url === e.url)
    t.ok(found, `route ${e.method} ${e.url} present`)
  }
})

test('work.orders.routes: every route has onRequest auth guard', (t) => {
  const routes = require(ROUTES_PATH)({})
  for (const r of routes) {
    t.ok(typeof r.onRequest === 'function', `${r.method} ${r.url} has onRequest`)
  }
})

test('work.orders.routes: list cache key includes every filter shortcut', (t) => {
  const { createCachedAuthRoute } = require('../../../workers/lib/server/lib/routeHelpers')
  let capturedKeyFn
  const orig = createCachedAuthRoute
  require.cache[require.resolve('../../../workers/lib/server/lib/routeHelpers')].exports.createCachedAuthRoute =
    (ctx, keyParts, endpoint, handler, perms) => {
      if (endpoint === ENDPOINTS.WORK_ORDERS) capturedKeyFn = keyParts
      return orig(ctx, keyParts, endpoint, handler, perms)
    }
  delete require.cache[require.resolve(ROUTES_PATH)]
  require(ROUTES_PATH)({})

  const req = {
    query: {
      query: '{"a":1}',
      sort: '{"code":1}',
      fields: '{}',
      offset: 0,
      limit: 10,
      q: 'IVI',
      assignee: 'u',
      creator: 'c',
      partId: 'p',
      status: 'open',
      type: 2,
      from: 1,
      to: 2
    }
  }
  const key = capturedKeyFn(req)
  for (const expected of ['{"a":1}', '{"code":1}', '{}', 0, 10, 'IVI', 'u', 'c', 'p', 'open', 2, 1, 2]) {
    t.ok(key.includes(expected), `cache key includes ${JSON.stringify(expected)}`)
  }

  require.cache[require.resolve('../../../workers/lib/server/lib/routeHelpers')].exports.createCachedAuthRoute = orig
})
