'use strict'

const test = require('brittle')
const fs = require('fs')
const { createWorker } = require('@tetherto/tether-svc-test-helper').worker
const { setTimeout: sleep } = require('timers/promises')
const HttpFacility = require('@bitfinex/bfx-facs-http')
const { ENDPOINTS } = require('../../workers/lib/constants')

test('Api security', { timeout: 90000 }, async (main) => {
  const baseDir = 'tests/integration'
  let worker
  let httpClient
  const appNodePort = 5000
  const ip = '127.0.0.1'
  const appNodeBaseUrl = `http://${ip}:${appNodePort}`
  const readonlyUser = 'readonly@test'
  const siteOperatorUser = 'siteoperator@test'
  const admin1 = 'admin1@test.test'
  const admin2 = 'admin2@test.test'
  const newCreatedUser = 'admin@test.test'
  let superadminUser
  const encoding = 'json'
  const tokenExpiredUser = 'tokenexpire@test'
  const invalidToken = 'invalid-token'

  const cleanIntegrationArtifacts = () => {
    for (const dir of ['store', 'status', 'config', 'db']) {
      fs.rmSync(`./${baseDir}/${dir}`, { recursive: true, force: true })
    }
  }

  main.teardown(async () => {
    await httpClient.stop()
    await worker.stop()
    // wait for worker to stop
    await sleep(2000)
    cleanIntegrationArtifacts()
  })

  const createConfig = () => {
    if (!fs.existsSync(`./${baseDir}/config/facs`)) {
      if (!fs.existsSync(`./${baseDir}/config`)) fs.mkdirSync(`./${baseDir}/config`)
      fs.mkdirSync(`./${baseDir}/config/facs`)
    }
    if (!fs.existsSync(`./${baseDir}/db`)) fs.mkdirSync(`./${baseDir}/db`)

    const commonConf = { dir_log: 'logs', debug: 0, orks: { 'cluster-1': { rpcPublicKey: '' } }, cacheTiming: {}, featureConfig: {} }
    const netConf = { r0: {} }
    const httpdConf = { h0: {} }
    const httpdOauthConf = {
      h0: { method: 'google', credentials: { client: { id: 'i', secret: 's' } }, users: [{ email: readonlyUser }, { email: tokenExpiredUser }, { email: siteOperatorUser, write: true }] },
      h1: { method: 'microsoft', credentials: { client: { id: 'i', secret: 's' }, tenant: 'test-tenant' }, users: [] }
    }
    const authConf = require('../../config/facs/auth.config.json')
    superadminUser = authConf.a0.superAdmin

    fs.writeFileSync(`./${baseDir}/config/common.json`, JSON.stringify(commonConf))
    fs.writeFileSync(`./${baseDir}/config/facs/net.config.json`, JSON.stringify(netConf))
    fs.writeFileSync(`./${baseDir}/config/facs/httpd.config.json`, JSON.stringify(httpdConf))
    fs.writeFileSync(`./${baseDir}/config/facs/httpd-oauth2.config.json`, JSON.stringify(httpdOauthConf))
    fs.writeFileSync(`./${baseDir}/config/facs/auth.config.json`, JSON.stringify(authConf))
  }

  const startWorker = async () => {
    worker = createWorker({
      env: 'test',
      wtype: 'wrk-node-http-test',
      rack: 'test-rack',
      tmpdir: baseDir,
      storeDir: 'test-store',
      serviceRoot: `${process.cwd()}/${baseDir}`,
      port: appNodePort
    })

    await worker.start()
    worker.worker.net_r0.jRequest = () => ({})
  }

  const createHttpClient = async () => {
    httpClient = new HttpFacility({}, { ns: 'c0', timeout: 30000, debug: false }, { env: 'test' })
    await httpClient.start()
  }

  const getTestToken = async (email) => {
    worker.worker.authLib._auth.addHandlers({
      google: () => { return { email } }
    })
    const token = await worker.worker.auth_a0.authCallbackHandler('google', { socket: { remoteAddress: ip } })
    return token
  }

  const createUser = async (email, role, token) => {
    if (!token) token = await getTestToken(superadminUser)

    await httpClient.post(`${appNodeBaseUrl}${ENDPOINTS.USERS}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        body: { data: { email, role } },
        encoding
      })
  }

  const testMissingAuthToken = async (httpClient, method, api, options = {}) => {
    try {
      await httpClient[method](api, { ...options, encoding: options.encoding || 'json' })
      throw new Error('Expected error for missing auth token but request succeeded')
    } catch (e) {
      if (!e.response || !e.response.message || !e.response.message.includes('ERR_AUTH_FAIL')) {
        throw new Error(`Expected ERR_AUTH_FAIL but got: ${e.message || e}`)
      }
      return true
    }
  }

  const testInvalidAuthToken = async (httpClient, method, api, invalidToken, options = {}) => {
    const headers = { Authorization: `Bearer ${invalidToken}` }
    try {
      await httpClient[method](api, { ...options, headers, encoding: options.encoding || 'json' })
      throw new Error('Expected error for invalid auth token but request succeeded')
    } catch (e) {
      if (!e.response || !e.response.message || !e.response.message.includes('ERR_AUTH_FAIL')) {
        throw new Error(`Expected ERR_AUTH_FAIL but got: ${e.message || e}`)
      }
      return true
    }
  }

  const testValidAuthToken = async (httpClient, method, api, userEmail, options = {}) => {
    const token = await getTestToken(userEmail)
    const headers = { Authorization: `Bearer ${token}` }
    try {
      await httpClient[method](api, { ...options, headers, encoding: options.encoding || 'json' })
      return true
    } catch (e) {
      throw new Error(`Expected success but got error: ${e.message || e}`)
    }
  }

  const testInvalidPermissions = async (httpClient, method, api, userEmail, expectedError, options = {}) => {
    const token = await getTestToken(userEmail)
    const headers = { Authorization: `Bearer ${token}` }
    try {
      await httpClient[method](api, { ...options, headers, encoding: options.encoding || 'json' })
      throw new Error('Expected error for invalid permissions but request succeeded')
    } catch (e) {
      if (!e.response || !e.response.message || !e.response.message.includes(expectedError)) {
        throw new Error(`Expected ${expectedError} but got: ${e.message || e}`)
      }
      return true
    }
  }

  const createAuthHeaders = async (userEmail) => {
    const token = await getTestToken(userEmail)
    return { Authorization: `Bearer ${token}` }
  }

  const createEndpointSecurityTests = (httpClient, method, api, invalidToken, options = {}, userEmail = 'readonly@test', encoding = 'json') => {
    const requestOptions = { ...options, encoding }

    return [
      {
        name: 'api should fail for missing auth token',
        test: () => testMissingAuthToken(httpClient, method, api, requestOptions)
      },
      {
        name: 'api should fail for invalid auth token',
        test: () => testInvalidAuthToken(httpClient, method, api, invalidToken, requestOptions)
      },
      {
        name: 'api should succeed for valid auth token',
        test: () => testValidAuthToken(httpClient, method, api, userEmail, requestOptions)
      }
    ]
  }

  const createEndpointSecurityWithPermissionsTests = (httpClient, method, api, invalidToken, permissionUser, permissionError, validUser, options = {}, encoding = 'json') => {
    return [
      {
        name: 'api should fail for missing auth token',
        test: () => testMissingAuthToken(httpClient, method, api, { ...options, encoding })
      },
      {
        name: 'api should fail for invalid auth token',
        test: () => testInvalidAuthToken(httpClient, method, api, invalidToken, { ...options, encoding })
      },
      {
        name: 'api should fail for invalid permissions',
        test: () => testInvalidPermissions(httpClient, method, api, permissionUser, permissionError, { ...options, encoding })
      },
      {
        name: 'api should succeed for valid auth token',
        test: () => testValidAuthToken(httpClient, method, api, validUser, { ...options, encoding })
      }
    ]
  }

  const runTestCases = async (n, testCases) => {
    for (const testCase of testCases) {
      await n.test(testCase.name, async (t) => {
        try {
          await testCase.test()
          t.pass(testCase.name)
        } catch (e) {
          t.fail(e.message)
        }
      })
    }
  }

  const testEndpointSecurity = async (n, httpClient, method, api, invalidToken, options = {}, userEmail = 'readonly@test', encoding = 'json') => {
    const tests = createEndpointSecurityTests(httpClient, method, api, invalidToken, options, userEmail, encoding)
    await runTestCases(n, tests)
  }

  const testGetEndpointSecurity = async (n, httpClient, api, invalidToken, userEmail = 'readonly@test', encoding = 'json') => {
    await testEndpointSecurity(n, httpClient, 'get', api, invalidToken, {}, userEmail, encoding)
  }

  const testPostEndpointSecurity = async (n, httpClient, api, invalidToken, body, userEmail = 'readonly@test', encoding = 'json') => {
    await testEndpointSecurity(n, httpClient, 'post', api, invalidToken, { body }, userEmail, encoding)
  }

  const testPutEndpointSecurity = async (n, httpClient, api, invalidToken, body, userEmail = 'readonly@test', encoding = 'json') => {
    await testEndpointSecurity(n, httpClient, 'put', api, invalidToken, { body }, userEmail, encoding)
  }

  const testDeleteEndpointSecurity = async (n, httpClient, api, invalidToken, options = {}, userEmail = 'readonly@test', encoding = 'json') => {
    await testEndpointSecurity(n, httpClient, 'delete', api, invalidToken, options, userEmail, encoding)
  }

  const testPostEndpointSecurityWithPermissions = async (n, httpClient, api, invalidToken, body, permissionUser, permissionError, validUser, encoding = 'json') => {
    const tests = createEndpointSecurityWithPermissionsTests(httpClient, 'post', api, invalidToken, permissionUser, permissionError, validUser, { body }, encoding)
    await runTestCases(n, tests)
  }

  const testPutEndpointSecurityWithPermissions = async (n, httpClient, api, invalidToken, body, permissionUser, permissionError, validUser, encoding = 'json') => {
    const tests = createEndpointSecurityWithPermissionsTests(httpClient, 'put', api, invalidToken, permissionUser, permissionError, validUser, { body }, encoding)
    await runTestCases(n, tests)
  }

  const testDeleteEndpointSecurityWithPermissions = async (n, httpClient, api, invalidToken, permissionUser, permissionError, validUser, options = {}, encoding = 'json') => {
    const tests = createEndpointSecurityWithPermissionsTests(httpClient, 'delete', api, invalidToken, permissionUser, permissionError, validUser, options, encoding)
    await runTestCases(n, tests)
  }

  const testEndpointWithAuth = async (t, httpClient, method, api, userEmail, options = {}) => {
    const headers = await createAuthHeaders(userEmail)
    try {
      await httpClient[method](api, { ...options, headers, encoding: options.encoding || 'json' })
      t.pass()
      return true
    } catch (e) {
      t.fail(`Expected success but got error: ${e.message || e}`)
      return false
    }
  }

  const testEndpointWithAuthAndError = async (t, httpClient, method, api, userEmail, expectedError, options = {}) => {
    const headers = await createAuthHeaders(userEmail)
    try {
      await httpClient[method](api, { ...options, headers, encoding: options.encoding || 'json' })
      t.fail('Expected error but request succeeded')
      return false
    } catch (e) {
      const hasError = e.response && e.response.message && e.response.message.includes(expectedError)
      if (!hasError) {
        t.fail(`Expected ${expectedError} but got: ${e.message || e}`)
        return false
      }
      t.pass()
      return true
    }
  }

  cleanIntegrationArtifacts()
  createConfig()
  await startWorker()
  await createHttpClient()
  await sleep(2000)
  await createUser(admin1, 'admin')
  await createUser(admin2, 'admin')

  await main.test('Api: list-things', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.LIST_THINGS}`
    await testGetEndpointSecurity(n, httpClient, api, invalidToken, readonlyUser, encoding)
  })

  await main.test('Api: list-racks', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.LIST_RACKS}?type=miner`
    await testGetEndpointSecurity(n, httpClient, api, invalidToken, readonlyUser, encoding)
  })

  await main.test('Api: post thing-comment', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.THING_COMMENT}`
    const body = { thingId: 1, rackId: 1, comment: 'test' }
    await testPostEndpointSecurity(n, httpClient, api, invalidToken, body, siteOperatorUser, encoding)
  })

  await main.test('Api: put thing-comment', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.THING_COMMENT}`
    const body = { thingId: 1, rackId: 1, comment: 'test' }
    await testPutEndpointSecurity(n, httpClient, api, invalidToken, body, siteOperatorUser, encoding)
  })

  await main.test('Api: delete thing-comment', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.THING_COMMENT}`
    const body = { thingId: 1, rackId: 1, id: 1 }
    await testDeleteEndpointSecurity(n, httpClient, api, invalidToken, { body }, siteOperatorUser, encoding)
  })

  await main.test('Api: get settings', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.SETTINGS}?rackId=1`
    await testGetEndpointSecurity(n, httpClient, api, invalidToken, readonlyUser, encoding)
  })

  await main.test('Api: put settings', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.SETTINGS}`
    const body = { rackId: 1, entries: { val: 1 } }
    await testPutEndpointSecurity(n, httpClient, api, invalidToken, body, siteOperatorUser, encoding)
  })

  await main.test('Api: get worker-config', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.WORKER_CONFIG}?type=miner`
    await testGetEndpointSecurity(n, httpClient, api, invalidToken, readonlyUser, encoding)
  })

  await main.test('Api: get thing-config', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.THING_CONFIG}?type=miner&requestType=miner`
    await testGetEndpointSecurity(n, httpClient, api, invalidToken, readonlyUser, encoding)
  })

  await main.test('Api: get tail-log', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.TAIL_LOG}?key=stat-5m`
    await testGetEndpointSecurity(n, httpClient, api, invalidToken, admin1, encoding)
  })

  await main.test('Api: get tail-log/multi', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.TAIL_LOG_MULTI}?keys=[]`
    await testGetEndpointSecurity(n, httpClient, api, invalidToken, admin1, encoding)
  })

  await main.test('Api: get tail-log/range-aggr', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.TAIL_LOG_RANGE_AGGR}?keys=[{"type":1,"startDate":1,"endDate":1}]`
    await testGetEndpointSecurity(n, httpClient, api, invalidToken, admin1, encoding)
  })

  await main.test('Api: get history-log', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.HISTORY_LOG}?logType=alerts`
    await testGetEndpointSecurity(n, httpClient, api, invalidToken, admin1, encoding)
  })

  await main.test('Api: get global/data', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.GLOBAL_DATA}?type=features`
    await testGetEndpointSecurity(n, httpClient, api, invalidToken, readonlyUser, encoding)
  })

  await main.test('Api: post global/data', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.GLOBAL_DATA}?type=features`
    const body = { data: { site: 'A' } }
    await testPostEndpointSecurityWithPermissions(n, httpClient, api, invalidToken, body, siteOperatorUser, 'ERR_AUTH_FAIL_NO_PERMS', admin1, encoding)
  })

  await main.test('Api: get user/settings', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.USER_SETTINGS}`
    await testGetEndpointSecurity(n, httpClient, api, invalidToken, readonlyUser, encoding)
  })

  await main.test('Api: post user/settings', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.USER_SETTINGS}`
    const body = { settings: { setting1: 'val-1' } }
    await testPostEndpointSecurity(n, httpClient, api, invalidToken, body, siteOperatorUser, encoding)
  })

  await main.test('Api: get featureConfig', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.FEATURE_CONFIG}`
    await testGetEndpointSecurity(n, httpClient, api, invalidToken, readonlyUser, encoding)
  })

  await main.test('Api: get features', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.FEATURES}`
    await testGetEndpointSecurity(n, httpClient, api, invalidToken, readonlyUser, encoding)
  })

  await main.test('Api: post features', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.FEATURES}`
    const body = { data: { key: 'val' } }
    await testPostEndpointSecurityWithPermissions(n, httpClient, api, invalidToken, body, siteOperatorUser, 'ERR_AUTH_FAIL_NO_PERMS', admin1, encoding)
  })

  await main.test('Api: get global-config', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.GLOBAL_CONFIG}`
    await testGetEndpointSecurity(n, httpClient, api, invalidToken, readonlyUser, encoding)
  })

  await main.test('Api: post global-config', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.GLOBAL_CONFIG}`
    const body = { data: { isAutoSleepAllowed: false } }
    await testPostEndpointSecurityWithPermissions(n, httpClient, api, invalidToken, body, siteOperatorUser, 'ERR_AUTH_FAIL_NO_PERMS', admin1, encoding)
  })

  await main.test('Api: get site', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.SITE}`
    await testGetEndpointSecurity(n, httpClient, api, invalidToken, readonlyUser, encoding)
  })

  await main.test('Api: get permissions', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.PERMISSIONS}`
    await testGetEndpointSecurity(n, httpClient, api, invalidToken, readonlyUser, encoding)
  })

  await main.test('Api: get userinfo', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.USERINFO}`
    await testGetEndpointSecurity(n, httpClient, api, invalidToken, readonlyUser, encoding)
  })

  await main.test('Api: get ext-data', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.EXT_DATA}?type=miner`
    await testGetEndpointSecurity(n, httpClient, api, invalidToken, readonlyUser, encoding)
  })

  await main.test('Api: get actions', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.ACTIONS}?queries=[]`
    await testGetEndpointSecurity(n, httpClient, api, invalidToken, siteOperatorUser, encoding)
  })

  await main.test('Api: get actions/batch', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.ACTIONS_BATCH}?ids=1,2`
    await testGetEndpointSecurity(n, httpClient, api, invalidToken, siteOperatorUser, encoding)
  })

  await main.test('Api: get actions/:type/:id', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.ACTIONS_SINGLE}`.replace(':type', 'done').replace(':id', 1)
    await testGetEndpointSecurity(n, httpClient, api, invalidToken, siteOperatorUser, encoding)
  })

  await main.test('Api: post actions/voting', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.ACTIONS_VOTING}`
    const body = { query: {}, action: '', params: [] }
    await testPostEndpointSecurity(n, httpClient, api, invalidToken, body, siteOperatorUser, encoding)
  })

  await main.test('Api: post actions/voting/batch', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.ACTIONS_VOTING_BATCH}`
    const body = { batchActionsPayload: [], batchActionUID: '' }
    await testPostEndpointSecurityWithPermissions(n, httpClient, api, invalidToken, body, readonlyUser, 'ERR_AUTH_FAIL_NO_PERMS', siteOperatorUser, encoding)
  })

  await main.test('Api: put actions/voting/:id/vote', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.ACTIONS_VOTE}`.replace(':id', 1)
    const body = { approve: false }
    await testPutEndpointSecurityWithPermissions(n, httpClient, api, invalidToken, body, readonlyUser, 'ERR_AUTH_FAIL_NO_PERMS', siteOperatorUser, encoding)
  })

  await main.test('Api: delete actions/voting/cancel', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.ACTIONS_CANCEL}?ids=1`
    await testDeleteEndpointSecurityWithPermissions(n, httpClient, api, invalidToken, readonlyUser, 'ERR_AUTH_FAIL_NO_PERMS', siteOperatorUser, { body: {} }, encoding)
  })

  await main.test('Api: post users', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.USERS}`

    await n.test('api should fail due to invalid permissions', async (t) => {
      await testEndpointWithAuthAndError(t, httpClient, 'post', api, readonlyUser, 'ERR_AUTH_FAIL_NO_PERMS', {
        body: { data: { email: 'dev@test.test', role: 'dev' } },
        encoding
      })
    })

    await n.test('api should succeed for valid permissions (superadmin)', async (t) => {
      await testEndpointWithAuth(t, httpClient, 'post', api, superadminUser, {
        body: { data: { email: newCreatedUser, role: 'admin' } },
        encoding
      })
    })

    await n.test('api should succeed for valid permissions (admin)', async (t) => {
      await testEndpointWithAuth(t, httpClient, 'post', api, newCreatedUser, {
        body: { data: { email: 'dev@test.test', role: 'read_only_user' } },
        encoding
      })
    })
  })

  await main.test('Api: get users', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.USERS}`

    await n.test('api should fail due to invalid permissions', async (t) => {
      await testEndpointWithAuthAndError(t, httpClient, 'get', api, readonlyUser, 'ERR_AUTH_FAIL_NO_PERMS', { encoding })
    })

    await n.test('api should succeed for valid permissions', async (t) => {
      await testEndpointWithAuth(t, httpClient, 'get', api, superadminUser, { encoding })
    })

    await n.test('users list should not contain superadmin user data', async (t) => {
      const headers = await createAuthHeaders(superadminUser)
      const { body: data } = await httpClient.get(api, { headers, encoding })
      t.is(data.users.length > 1, true)
      data.users.forEach(user => {
        if (user.role === 'superadmin') t.fail()
      })
    })

    await n.test('admin user should not access superadmin user data', async (t) => {
      const headers = await createAuthHeaders(admin1)
      const { body: data } = await httpClient.get(api, { headers, encoding })
      t.is(data.users.length > 1, true)
      t.ok(data.users.every(u => u.role !== 'superadmin'), 'admin should not see superadmin')
      t.ok(data.users.some(u => u.role === 'admin'), 'admin can see other admins per roleManagement')
    })
  })

  await main.test('Api: put users', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.USERS}`
    const headers = await createAuthHeaders(superadminUser)
    const { body: list } = await httpClient.get(api, { headers, encoding })
    const target = list.users.find(u => u.email === 'dev@test.test')

    await n.test('api should fail due to invalid permissions', async (t) => {
      t.ok(target, 'test user dev@test.test should exist')
      await testEndpointWithAuthAndError(t, httpClient, 'put', api, readonlyUser, 'ERR_AUTH_FAIL_NO_PERMS', {
        body: { data: { id: target.id, email: 'dev@test.test', role: 'admin' } },
        encoding
      })
    })

    await n.test('api should succeed for valid permissions', async (t) => {
      t.ok(target, 'test user dev@test.test should exist')
      await testEndpointWithAuth(t, httpClient, 'put', api, superadminUser, {
        body: { data: { id: target.id, email: 'dev@test.test', role: 'admin' } },
        encoding
      })
    })

    await n.test('api should fail for missing users write permissions', async (t) => {
      t.ok(target, 'test user dev@test.test should exist')
      await testEndpointWithAuthAndError(t, httpClient, 'put', api, siteOperatorUser, 'ERR_AUTH_FAIL_NO_PERMS', {
        body: { data: { id: target.id, email: 'dev@test.test', role: 'read_only_user' } },
        encoding
      })
    })
  })

  await main.test('Api: post users/delete', async (n) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.USERS_DELETE}`
    const usersApi = `${appNodeBaseUrl}${ENDPOINTS.USERS}`
    const headers = await createAuthHeaders(superadminUser)
    const { body: list } = await httpClient.get(usersApi, { headers, encoding })
    const deleteTarget = list.users.find(u => u.email === 'dev@test.test')
    const permTarget = list.users.find(u => u.email !== 'dev@test.test')

    await n.test('api should fail due to invalid permissions', async (t) => {
      t.ok(deleteTarget, 'delete target user should exist')
      await testEndpointWithAuthAndError(t, httpClient, 'post', api, readonlyUser, 'ERR_AUTH_FAIL_NO_PERMS', {
        body: { data: { id: deleteTarget.id } },
        encoding
      })
    })

    await n.test('api should succeed for valid permissions', async (t) => {
      t.ok(deleteTarget, 'delete target user should exist')
      await testEndpointWithAuth(t, httpClient, 'post', api, superadminUser, {
        body: { data: { id: deleteTarget.id } },
        encoding
      })
    })

    await n.test('api should fail for missing permissions', async (t) => {
      t.ok(permTarget, 'permission target user should exist')
      await testEndpointWithAuthAndError(t, httpClient, 'post', api, siteOperatorUser, 'ERR_AUTH_FAIL_NO_PERMS', {
        body: { data: { id: permTarget.id } },
        encoding
      })
    })
  })

  await main.test('Token expiration: api should fail due to token expiration', async (t) => {
    const api = `${appNodeBaseUrl}${ENDPOINTS.LIST_RACKS}?type=miner`
    worker.worker.auth_a0.conf.ttl = 5
    const token = await getTestToken(tokenExpiredUser)
    const headers = { Authorization: `Bearer ${token}` }
    await sleep(6000)
    try {
      await httpClient.get(api, { headers, encoding })
      t.fail()
    } catch (e) {
      t.is(e.response.message.includes('ERR_AUTH_FAIL'), true)
    }
  })
})
