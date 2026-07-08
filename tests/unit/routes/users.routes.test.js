'use strict'

const test = require('brittle')
const { testModuleStructure, testHandlerFunctions, testOnRequestFunctions } = require('../helpers/routeTestHelpers')
const { createRoutesForTest } = require('../helpers/mockHelpers')

test('users routes - module structure', (t) => {
  testModuleStructure(t, '../../../workers/lib/server/routes/users.routes.js', 'users')
  t.pass()
})

test('users routes - route definitions', (t) => {
  const routes = createRoutesForTest('../../../workers/lib/server/routes/users.routes.js')

  const routeUrls = routes.map(route => route.url)
  t.ok(routeUrls.includes('/auth/users'), 'should have users route')
  t.ok(routeUrls.includes('/auth/users/delete'), 'should have users delete route')
  t.ok(routeUrls.includes('/auth/roles/permissions'), 'should have roles permissions route')

  t.pass()
})

test('users routes - HTTP methods', (t) => {
  const routes = createRoutesForTest('../../../workers/lib/server/routes/users.routes.js')

  const postRoute = routes.find(r => r.url === '/auth/users' && r.method === 'POST')
  t.ok(postRoute, 'should have POST route for creating users')

  const getRoute = routes.find(r => r.url === '/auth/users' && r.method === 'GET')
  t.ok(getRoute, 'should have GET route for listing users')

  const putRoute = routes.find(r => r.url === '/auth/users' && r.method === 'PUT')
  t.ok(putRoute, 'should have PUT route for updating users')

  const deleteRoute = routes.find(r => r.url === '/auth/users/delete' && r.method === 'POST')
  t.ok(deleteRoute, 'should have POST route for deleting users')

  const rolesPermsRoute = routes.find(r => r.url === '/auth/roles/permissions' && r.method === 'GET')
  t.ok(rolesPermsRoute, 'should have GET route for roles permissions')

  t.pass()
})

test('users routes - schema validation', (t) => {
  const routes = createRoutesForTest('../../../workers/lib/server/routes/users.routes.js')

  const postRoute = routes.find(r => r.url === '/auth/users' && r.method === 'POST')
  t.ok(postRoute.schema, 'POST route should have schema')
  t.ok(postRoute.schema.body, 'POST route should have body schema')
  t.ok(postRoute.schema.body.required.includes('data'), 'data should be required')
  t.ok(postRoute.schema.body.properties.data.required.includes('email'), 'email should be required')
  t.ok(postRoute.schema.body.properties.data.required.includes('role'), 'role should be required')

  const putRoute = routes.find(r => r.url === '/auth/users' && r.method === 'PUT')
  t.ok(putRoute.schema, 'PUT route should have schema')
  t.ok(putRoute.schema.body.properties.data.required.includes('id'), 'id should be required in PUT')

  t.pass()
})

test('users routes - onRequest functions', (t) => {
  const routes = createRoutesForTest('../../../workers/lib/server/routes/users.routes.js')
  testOnRequestFunctions(t, routes, 'users')
  t.pass()
})

test('users routes - handler functions', (t) => {
  const routes = createRoutesForTest('../../../workers/lib/server/routes/users.routes.js')
  testHandlerFunctions(t, routes, 'users')
  t.pass()
})

test('users routes - GET /auth/users allows admin_external to read the users list', async (t) => {
  const AuthLib = require('../../../workers/lib/auth')
  const { a0: { roles, roleManagement } } = require('../../../config/facs/auth.config.json')
  const usersRoutesFactory = require('../../../workers/lib/server/routes/users.routes.js')

  const mockAuthFacility = {
    resolveToken: async () => ({
      userId: 'ext-1',
      metadata: { email: 'ext@example.com', roles: '["admin_external"]' }
    }),
    getTokenPerms: () => ({ superadmin: false, perms: roles.admin_external }),
    conf: { superAdminPerms: [] }
  }
  const authLib = new AuthLib({ httpc: {}, httpd: {}, userService: {}, auth: mockAuthFacility })

  const mockCtx = {
    conf: { ttl: 3600 },
    authLib,
    auth_a0: { conf: { roles, roleManagement } },
    userService: {
      listUsers: async () => [
        { id: 1, email: 'admin@example.com', role: 'admin' },
        { id: 2, email: 'site.manager@example.com', role: 'site_manager' },
        { id: 3, email: 'external@example.com', role: 'admin_external' }
      ]
    }
  }

  const route = usersRoutesFactory(mockCtx).find(r => r.url === '/auth/users' && r.method === 'GET')

  const mockReq = {
    headers: { authorization: 'Bearer admin-external-token' },
    ip: '127.0.0.1',
    _info: {}
  }

  let statusCode = null
  let responseBody = null
  const mockRep = {
    status: function (code) { statusCode = code; return this },
    send: function (data) { responseBody = data; return this }
  }

  await route.onRequest(mockReq, mockRep)
  t.ok(statusCode === null, 'admin_external should not be denied by authCheck/capCheck')

  await route.handler(mockReq, mockRep)
  t.is(statusCode, 200, 'should respond with 200')
  t.ok(Array.isArray(responseBody.users), 'should return a users array')
  t.ok(responseBody.users.every(u => u.role !== 'admin'), 'admin_external should not see admin users, per roleManagement filtering')
  t.ok(responseBody.users.some(u => u.role === 'site_manager'), 'admin_external should see roles it manages')

  t.pass()
})

test('users routes - GET /auth/users denies roles without the users capability', async (t) => {
  const AuthLib = require('../../../workers/lib/auth')
  const { a0: { roles } } = require('../../../config/facs/auth.config.json')
  const usersRoutesFactory = require('../../../workers/lib/server/routes/users.routes.js')

  const mockAuthFacility = {
    resolveToken: async () => ({
      userId: 'ro-1',
      metadata: { email: 'ro@example.com', roles: '["read_only_user"]' }
    }),
    getTokenPerms: () => ({ superadmin: false, perms: roles.read_only_user }),
    conf: { superAdminPerms: [] }
  }
  const authLib = new AuthLib({ httpc: {}, httpd: {}, userService: {}, auth: mockAuthFacility })

  const mockCtx = {
    conf: { ttl: 3600 },
    authLib
  }

  const route = usersRoutesFactory(mockCtx).find(r => r.url === '/auth/users' && r.method === 'GET')

  const mockReq = {
    headers: { authorization: 'Bearer read-only-token' },
    ip: '127.0.0.1',
    _info: {}
  }

  let statusCode = null
  let responseBody = null
  const mockRep = {
    status: function (code) { statusCode = code; return this },
    send: function (data) { responseBody = data; return this }
  }

  await route.onRequest(mockReq, mockRep)
  t.is(statusCode, 401, 'read_only_user should be denied since it lacks the users capability')
  t.is(responseBody.message, 'ERR_AUTH_FAIL_NO_PERMS', 'should return ERR_AUTH_FAIL_NO_PERMS')

  t.pass()
})
