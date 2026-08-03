'use strict'

const test = require('brittle')
const { testModuleStructure, testHandlerFunctions, testPreHandlerFunctions, testPreValidationFunctions } = require('../helpers/routeTestHelpers')

test('logs routes - module structure', (t) => {
  testModuleStructure(t, '../../../workers/lib/server/routes/logs.routes.js', 'logs')
  t.pass()
})

test('logs routes - route definitions', (t) => {
  const mockCtx = {}
  const routes = require('../../../workers/lib/server/routes/logs.routes.js')(mockCtx)

  const routeUrls = routes.map(route => route.url)
  t.ok(routeUrls.some(url => url.includes('tail-log') && !url.includes('multi') && !url.includes('range')), 'should have tail-log route')
  t.ok(routeUrls.some(url => url.includes('tail-log') && url.includes('multi')), 'should have tail-log multi route')
  t.ok(routeUrls.some(url => url.includes('tail-log') && url.includes('range')), 'should have tail-log range-aggr route')
  t.ok(routeUrls.some(url => url.includes('history-log')), 'should have history-log route')

  t.pass()
})

test('logs routes - HTTP methods', (t) => {
  const mockCtx = {}
  const routes = require('../../../workers/lib/server/routes/logs.routes.js')(mockCtx)

  routes.forEach(route => {
    t.is(route.method, 'GET', `route ${route.url} should be GET`)
  })

  t.pass()
})

test('logs routes - schema validation', (t) => {
  const mockCtx = {}
  const routes = require('../../../workers/lib/server/routes/logs.routes.js')(mockCtx)

  const tailLogRoute = routes.find(r => r.url?.includes('tail-log') && !r.url.includes('multi') && !r.url.includes('range'))
  if (tailLogRoute) {
    t.ok(tailLogRoute.schema, 'tail-log route should have schema')
    t.ok(tailLogRoute.schema.querystring, 'tail-log route should have querystring schema')
    t.ok(tailLogRoute.schema.querystring.required.includes('key'), 'key should be required')
  }

  const tailLogMultiRoute = routes.find(r => r.url?.includes('tail-log') && r.url.includes('multi'))
  if (tailLogMultiRoute) {
    t.ok(tailLogMultiRoute.schema, 'tail-log multi route should have schema')
    t.ok(tailLogMultiRoute.schema.querystring.required.includes('keys'), 'keys should be required')
  }

  const historyLogRoute = routes.find(r => r.url?.includes('history-log'))
  if (historyLogRoute) {
    t.ok(historyLogRoute.schema, 'history-log route should have schema')
    t.ok(historyLogRoute.schema.querystring.required.includes('logType'), 'logType should be required')
  }

  t.pass()
})

test('logs routes - preValidation functions', (t) => {
  const mockCtx = {}
  const routes = require('../../../workers/lib/server/routes/logs.routes.js')(mockCtx)
  testPreValidationFunctions(t, routes, 'logs')
  t.pass()
})

test('logs routes - handler functions', (t) => {
  const mockCtx = {}
  const routes = require('../../../workers/lib/server/routes/logs.routes.js')(mockCtx)
  testHandlerFunctions(t, routes, 'logs')
  t.pass()
})

test('logs routes - preHandler functions', (t) => {
  const mockCtx = {}
  const routes = require('../../../workers/lib/server/routes/logs.routes.js')(mockCtx)
  testPreHandlerFunctions(t, routes, 'logs')
  t.pass()
})

test('logs routes - limit cap admits the widest limit the UI sends', (t) => {
  const mockCtx = {}
  const routes = require('../../../workers/lib/server/routes/logs.routes.js')(mockCtx)

  // the dashboard power-mode timeline asks for 7 days of stat-1m. Capping below
  // this would reject that chart outright, so it is pinned rather than assumed.
  const DASHBOARD_LIMIT = 10080

  const tailLogRoutes = routes.filter(r => r.url?.includes('tail-log') && !r.url.includes('range'))
  t.is(tailLogRoutes.length, 2, 'should cover both the single and multi tail-log routes')

  tailLogRoutes.forEach(route => {
    const { limit } = route.schema.querystring.properties
    t.is(limit.minimum, 1, `${route.url} should reject a non-positive limit`)
    t.ok(limit.maximum >= DASHBOARD_LIMIT, `${route.url} should admit the dashboard limit`)
  })

  t.pass()
})
