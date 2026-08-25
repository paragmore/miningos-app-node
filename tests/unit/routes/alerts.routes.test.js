'use strict'

const test = require('brittle')
const { testModuleStructure, testHandlerFunctions, testOnRequestFunctions } = require('../helpers/routeTestHelpers')
const { createRoutesForTest } = require('../helpers/mockHelpers')

const ROUTES_PATH = '../../../workers/lib/server/routes/alerts.routes.js'

test('alerts routes - module structure', (t) => {
  testModuleStructure(t, ROUTES_PATH, 'alerts')
  t.pass()
})

test('alerts routes - route definitions', (t) => {
  const routes = createRoutesForTest(ROUTES_PATH)

  const routeUrls = routes.map(route => route.url)
  t.ok(routeUrls.includes('/auth/alerts/site'), 'should have site alerts route')
  t.ok(routeUrls.includes('/auth/alerts/history'), 'should have alerts history route')
  t.ok(routeUrls.includes('/auth/alerts/config'), 'should have alert config route')
  t.ok(routeUrls.includes('/auth/alerts/params'), 'should have alert params route')

  t.pass()
})

test('alerts routes - HTTP methods', (t) => {
  const routes = createRoutesForTest(ROUTES_PATH)

  const postRoutes = routes.filter(route => route.method === 'POST')
  const getRoutes = routes.filter(route => route.method === 'GET')

  t.is(postRoutes.length, 1, 'should have exactly one POST route')
  t.is(postRoutes[0].url, '/auth/alerts/params', 'the POST route should be alerts/params')
  t.is(getRoutes.length, routes.length - 1, 'every other route should be GET')

  t.pass()
})

test('alerts routes - alerts/params has both GET and POST', (t) => {
  const routes = createRoutesForTest(ROUTES_PATH)
  const paramsRoutes = routes.filter(route => route.url === '/auth/alerts/params')

  t.is(paramsRoutes.length, 2, 'should register both GET and POST for alerts/params')
  t.ok(paramsRoutes.some(route => route.method === 'GET'), 'should have GET')
  t.ok(paramsRoutes.some(route => route.method === 'POST'), 'should have POST')

  t.pass()
})

test('alerts routes - schema integration', (t) => {
  const routes = createRoutesForTest(ROUTES_PATH)

  routes.forEach(route => {
    t.ok(route.schema, `route ${route.url} should have schema`)
    if (route.schema.querystring) {
      t.ok(typeof route.schema.querystring === 'object', `route ${route.url} querystring should be object`)
    }
    if (route.schema.body) {
      t.ok(typeof route.schema.body === 'object', `route ${route.url} body should be object`)
    }
  })

  t.pass()
})

test('alerts routes - handler functions', (t) => {
  const routes = createRoutesForTest(ROUTES_PATH)
  testHandlerFunctions(t, routes, 'alerts')
  t.pass()
})

test('alerts routes - onRequest functions', (t) => {
  const routes = createRoutesForTest(ROUTES_PATH)
  testOnRequestFunctions(t, routes, 'alerts')
  t.pass()
})
