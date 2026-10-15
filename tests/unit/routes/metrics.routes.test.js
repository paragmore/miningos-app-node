'use strict'

const test = require('brittle')
const { testModuleStructure, testHandlerFunctions, testOnRequestFunctions } = require('../helpers/routeTestHelpers')
const { createRoutesForTest } = require('../helpers/mockHelpers')

const ROUTES_PATH = '../../../workers/lib/server/routes/metrics.routes.js'

test('metrics routes - module structure', (t) => {
  testModuleStructure(t, ROUTES_PATH, 'metrics')
  t.pass()
})

test('metrics routes - route definitions', (t) => {
  const routes = createRoutesForTest(ROUTES_PATH)

  const routeUrls = routes.map(route => route.url)
  t.ok(routeUrls.includes('/auth/metrics/hashrate'), 'should have hashrate route')
  t.ok(routeUrls.includes('/auth/metrics/pool-hashrate'), 'should have pool-hashrate route')
  t.ok(routeUrls.includes('/auth/metrics/consumption'), 'should have consumption route')
  t.ok(routeUrls.includes('/auth/metrics/efficiency'), 'should have efficiency route')
  t.ok(routeUrls.includes('/auth/metrics/miner-status'), 'should have miner-status route')
  t.ok(routeUrls.includes('/auth/metrics/power-mode'), 'should have power-mode route')
  t.ok(routeUrls.includes('/auth/metrics/power-mode/timeline'), 'should have power-mode/timeline route')
  t.ok(routeUrls.includes('/auth/metrics/temperature'), 'should have temperature route')
  t.ok(routeUrls.includes('/auth/metrics/containers/:id'), 'should have container telemetry route')
  t.ok(routeUrls.includes('/auth/metrics/containers/:id/history'), 'should have container history route')
  t.ok(routeUrls.includes('/auth/metrics/miners/by-type'), 'should have miners by-type route')
  t.ok(routeUrls.includes('/auth/metrics/inventory/miner-distribution'), 'should have miner distribution route')
  t.ok(routeUrls.includes('/auth/metrics/downtime'), 'should have downtime route')

  t.pass()
})

test('metrics routes - HTTP methods', (t) => {
  const routes = createRoutesForTest(ROUTES_PATH)

  routes.forEach(route => {
    t.is(route.method, 'GET', `route ${route.url} should be GET`)
  })

  t.pass()
})

test('metrics routes - schema integration', (t) => {
  const routes = createRoutesForTest(ROUTES_PATH)

  const routesWithSchemas = routes.filter(route => route.schema)
  routesWithSchemas.forEach(route => {
    t.ok(route.schema, `route ${route.url} should have schema`)
    if (route.schema.querystring) {
      t.ok(typeof route.schema.querystring === 'object', `route ${route.url} querystring should be object`)
    }
  })

  t.pass()
})

// Honour it or reject it: only downtime buckets on the zone, so it is the only one of
// these that still declares `timezone`; the rest refuse it before schema validation.
const runPreValidation = (route, query) => {
  let result
  route.preValidation({ query }, {}, (err) => { result = err || null })
  return result
}

test('metrics routes - timezone is declared only where it is used', (t) => {
  const routes = createRoutesForTest(ROUTES_PATH)
  const rejecting = [
    '/auth/metrics/pool-hashrate',
    '/auth/metrics/consumption',
    '/auth/metrics/efficiency',
    '/auth/metrics/miner-status',
    '/auth/metrics/revenue/hourly',
    '/auth/metrics/power-mode',
    '/auth/metrics/power-mode/timeline',
    '/auth/metrics/temperature',
    '/auth/metrics/cooling',
    '/auth/metrics/containers/:id/history'
  ]

  for (const url of rejecting) {
    const route = routes.find(r => r.url === url)
    t.absent(route.schema.querystring.properties.timezone, `${url} does not declare timezone`)
    t.is(runPreValidation(route, { timezone: 'UTC' })?.message, 'ERR_TIMEZONE_UNSUPPORTED', `${url} rejects timezone`)
    t.is(runPreValidation(route, {}), null, `${url} passes without timezone`)
  }

  const downtime = routes.find(r => r.url === '/auth/metrics/downtime')
  t.alike(downtime.schema.querystring.properties.timezone, { type: 'string', maxLength: 100 }, 'downtime buckets on it')
  t.pass()
})

test('metrics routes - downtime accepts timezone only for the daily rollup', (t) => {
  const downtime = createRoutesForTest(ROUTES_PATH).find(route => route.url === '/auth/metrics/downtime')
  const DAY = 86400000

  t.is(runPreValidation(downtime, { start: '0', end: String(DAY), interval: '1d', timezone: 'UTC' }), null, 'explicit 1d uses it')
  t.is(runPreValidation(downtime, { start: '0', end: String(3 * DAY), timezone: 'UTC' }), null, 'automatic 1d (over 2 days) uses it')
  t.is(runPreValidation(downtime, { start: '0', end: String(3 * DAY), interval: '1h', timezone: 'UTC' })?.message, 'ERR_TIMEZONE_UNSUPPORTED', 'explicit 1h rejects it')
  t.is(runPreValidation(downtime, { start: '0', end: String(2 * DAY), timezone: 'UTC' })?.message, 'ERR_TIMEZONE_UNSUPPORTED', 'automatic 1h (2 days or less) rejects it')
  t.is(runPreValidation(downtime, { start: '0', end: String(DAY) }), null, 'passes without it')
  t.pass()
})

test('metrics routes - hashrate accepts timezone only for the 1M rollup', (t) => {
  const hashrate = createRoutesForTest(ROUTES_PATH).find(route => route.url === '/auth/metrics/hashrate')

  t.is(runPreValidation(hashrate, { interval: '1M', timezone: 'UTC' }), null, '1M rollup uses it')
  t.is(runPreValidation(hashrate, { interval: '1d', timezone: 'UTC' })?.message, 'ERR_TIMEZONE_UNSUPPORTED', 'other intervals reject it')
  t.is(runPreValidation(hashrate, { interval: '1M', groupBy: 'container', timezone: 'UTC' })?.message, 'ERR_TIMEZONE_UNSUPPORTED', 'grouped 1M does not roll up, so rejects it')
  t.is(runPreValidation(hashrate, { interval: '1M', racks: 'r1', timezone: 'UTC' })?.message, 'ERR_TIMEZONE_UNSUPPORTED', 'rack-scoped 1M rejects it')
  t.pass()
})

test('metrics routes - hashrate keeps its own timezone semantics', (t) => {
  const routes = createRoutesForTest(ROUTES_PATH)
  const hashrate = routes.find(route => route.url === '/auth/metrics/hashrate')

  t.alike(hashrate.schema.querystring.properties.timezone, { type: 'string' }, 'unchanged - used only for the 1M rollup boundary')
  t.pass()
})

test('metrics routes - handler functions', (t) => {
  const routes = createRoutesForTest(ROUTES_PATH)
  testHandlerFunctions(t, routes, 'metrics')
  t.pass()
})

test('metrics routes - onRequest functions', (t) => {
  const routes = createRoutesForTest(ROUTES_PATH)
  testOnRequestFunctions(t, routes, 'metrics')
  t.pass()
})

test('metrics routes - pool-hashrate accepts minerpool or pool_config', async (t) => {
  const checks = []
  const ctx = {
    conf: { ttl: 3600 },
    authLib: {
      resolveToken: async () => ({ userId: 'u1' }),
      tokenHasPerms: async (token, write, perms) => {
        checks.push({ write, perms })
        return true
      }
    }
  }
  const route = require(ROUTES_PATH)(ctx).find(r => r.url === '/auth/metrics/pool-hashrate')
  const req = { method: 'GET', headers: { authorization: 'Bearer token' }, ip: '127.0.0.1', query: {} }
  const rep = { status: () => { t.fail('should not be denied'); return rep }, send: () => rep }
  await route.onRequest(req, rep)

  t.alike(checks, [{ write: false, perms: ['minerpool', 'pool_config'] }])
})
