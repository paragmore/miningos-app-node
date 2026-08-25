'use strict'

const test = require('brittle')
const {
  getSiteAlerts,
  getAlertsHistory,
  getAlertConf,
  getAlertParams,
  setAlertParams,
  restrictToNotesOnly,
  extractAlertsFromThings,
  matchesSearch,
  applySort,
  buildSeveritySummary,
  buildSiteAlertsSummary,
  flattenHistoryAlert
} = require('../../../workers/lib/server/handlers/alerts.handlers')
const { validateFilter, applyMongoFilter, combineAnd, deduplicateAlerts } = require('../../../workers/lib/utils')
const {
  SITE_ALERTS_FILTER_FIELDS,
  ALERTS_FILTER_OPERATORS,
  GLOBAL_DATA_TYPES,
  CUSTOM_ALERT_CONFIG
} = require('../../../workers/lib/constants')
const { createMockCtxWithOrks, withDataProxy } = require('../helpers/mockHelpers')

// ==================== Alert config/params Tests ====================

test('getAlertConf - returns the static custom alert config', async (t) => {
  const result = await getAlertConf({})

  t.is(result, CUSTOM_ALERT_CONFIG, 'should return the shared config constant')
  t.ok(result['custom.low_hashrate.warning'], 'should include a known alert key')
  t.alike(result['custom.low_hashrate.warning'].rackTypes, ['miner'], 'should expose rackTypes for the alert')
})

test('getAlertParams - reads params from globalDataLib by type', async (t) => {
  let capturedReq
  const mockCtx = {
    globalDataLib: {
      getGlobalData: async (req) => {
        capturedReq = req
        return { 'custom.low_hashrate.warning': { enabled: true, minHashRateMhs: 50 } }
      }
    }
  }

  const result = await getAlertParams(mockCtx)

  t.is(capturedReq.type, GLOBAL_DATA_TYPES.ALERT_PARAMETERS, 'should query the alertParameters global data type')
  t.alike(result, { 'custom.low_hashrate.warning': { enabled: true, minHashRateMhs: 50 } })
})

test('setAlertParams - persists to globalDataLib and notifies orks grouped by rack type', async (t) => {
  const captured = []
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (pk, method, params) => {
        captured.push({ method, params })
        return { ok: true }
      }
    },
    authLib: { tokenHasPerms: async () => true },
    globalDataLib: {
      setGlobalData: async (data, type) => {
        t.is(type, GLOBAL_DATA_TYPES.ALERT_PARAMETERS, 'should save under the alertParameters type')
        return { data, updatedAt: 1 }
      }
    }
  })

  const mockReq = {
    _info: { authToken: 'token' },
    body: {
      data: {
        'custom.low_hashrate.warning': { enabled: true, minHashRateMhs: 50 },
        'custom.high_supply_temp.critical': { enabled: true, maxTempC: 90 }
      }
    }
  }

  const result = await setAlertParams(mockCtx, mockReq)

  t.alike(result, { data: mockReq.body.data, updatedAt: 1 }, 'should return the globalDataLib result')

  // the ork notification is fire-and-forget; give its microtask a tick to run
  await new Promise((resolve) => setImmediate(resolve))

  t.is(captured.length, 1, 'should notify the ork once')
  t.is(captured[0].method, 'setAlertParams', 'should call setAlertParams on the ork')
  t.alike(captured[0].params, {
    byRackType: {
      miner: { 'custom.low_hashrate.warning': { enabled: true, minHashRateMhs: 50 } },
      dcs: { 'custom.high_supply_temp.critical': { enabled: true, maxTempC: 90 } }
    }
  }, 'should group params by each alert key\'s rackTypes')
})

test('setAlertParams - skips unknown alert keys when grouping by rack type', async (t) => {
  const captured = []
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (pk, method, params) => {
        captured.push({ method, params })
        return { ok: true }
      }
    },
    authLib: { tokenHasPerms: async () => true },
    globalDataLib: {
      setGlobalData: async (data, type) => ({ data, type })
    }
  })

  const mockReq = {
    _info: { authToken: 'token' },
    body: {
      data: { 'custom.unknown_alert': { enabled: true } }
    }
  }

  await setAlertParams(mockCtx, mockReq)
  await new Promise((resolve) => setImmediate(resolve))

  t.alike(captured[0].params, { byRackType: {} }, 'unknown alert key contributes nothing to byRackType')
})

test('setAlertParams - fans a single alert key out to all of its rack types', async (t) => {
  const captured = []
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (pk, method, params) => {
        captured.push(params)
        return { ok: true }
      }
    },
    authLib: { tokenHasPerms: async () => true },
    globalDataLib: {
      setGlobalData: async (data, type) => ({ data, type })
    }
  })

  // tower_vibration is a dcs-only alert; confirm it still lands under dcs and nowhere else
  const mockReq = {
    _info: { authToken: 'token' },
    body: {
      data: { 'custom.tower_vibration.critical': { enabled: true, onError: true } }
    }
  }

  await setAlertParams(mockCtx, mockReq)
  await new Promise((resolve) => setImmediate(resolve))

  t.alike(captured[0], {
    byRackType: {
      dcs: { 'custom.tower_vibration.critical': { enabled: true, onError: true } }
    }
  })
})

test('setAlertParams - restricts users without alert_config_sensitive:w to updating notes only', async (t) => {
  const captured = []
  let capturedPerms
  const mockCtx = withDataProxy({
    conf: { orks: [{ rpcPublicKey: 'key1' }] },
    net_r0: {
      jRequest: async (pk, method, params) => {
        captured.push(params)
        return { ok: true }
      }
    },
    authLib: {
      tokenHasPerms: async (token, write, perms) => {
        capturedPerms = { token, write, perms }
        return false
      }
    },
    globalDataLib: {
      getGlobalData: async () => ([{
        'custom.low_hashrate.warning': { enabled: true, minHashRateMhs: 50, notes: 'old notes' },
        'custom.high_supply_temp.critical': { enabled: false, maxTempC: 80, notes: 'other' }
      }]),
      setGlobalData: async (data, type) => ({ data, type })
    }
  })

  const mockReq = {
    _info: { authToken: 'token' },
    body: {
      data: {
        'custom.low_hashrate.warning': { enabled: false, minHashRateMhs: 999, notes: 'new notes' }
      }
    }
  }

  const result = await setAlertParams(mockCtx, mockReq)

  t.is(capturedPerms.token, 'token', 'should check perms using the request auth token')
  t.alike(capturedPerms.perms, ['alert_config_sensitive:w'], 'should check the sensitive alert config permission')

  t.alike(result.data, {
    'custom.low_hashrate.warning': { enabled: true, minHashRateMhs: 50, notes: 'new notes' }
  }, 'should keep existing fields and only apply the submitted notes')

  await new Promise((resolve) => setImmediate(resolve))

  t.alike(captured[0], {
    byRackType: {
      miner: { 'custom.low_hashrate.warning': { enabled: true, minHashRateMhs: 50, notes: 'new notes' } }
    }
  }, 'should notify orks with the notes-only merged config')
})

test('restrictToNotesOnly - drops every submitted field except notes', (t) => {
  const submittedData = {
    'custom.low_hashrate.warning': { enabled: false, minHashRateMhs: 999, notes: 'new notes' },
    // no matching entry in existingConfig for this key
    'custom.unknown_alert': { enabled: true, threshold: 123, notes: 'unknown notes' }
  }
  const existingConfig = {
    'custom.low_hashrate.warning': { enabled: true, minHashRateMhs: 50, notes: 'old notes' }
  }

  const result = restrictToNotesOnly(submittedData, existingConfig)

  t.alike(result, {
    'custom.low_hashrate.warning': { enabled: true, minHashRateMhs: 50, notes: 'new notes' },
    'custom.unknown_alert': { notes: 'unknown notes' }
  }, 'submitted enabled/threshold values are ignored; only notes carries through, existing fields win everywhere else')
})

// ==================== extractAlertsFromThings Tests ====================

test('extractAlertsFromThings - extracts alerts with device info', (t) => {
  const things = [
    {
      id: 'miner-1',
      type: 'miner',
      code: 'S19',
      info: { container: 'container-A', pos: '1-2_c3' },
      last: {
        alerts: [
          { severity: 'high', name: 'Fan failure' },
          { severity: 'low', name: 'Temp warning' }
        ]
      }
    }
  ]

  const result = extractAlertsFromThings(things)
  t.is(result.length, 2, 'should extract 2 alerts')
  t.is(result[0].id, 'miner-1', 'should enrich with device id')
  t.is(result[0].type, 'miner', 'should enrich with device type')
  t.is(result[0].code, 'S19', 'should enrich with device code')
  t.is(result[0].container, 'container-A', 'should enrich with container')
  t.is(result[0].position, '1-2_c3', 'should enrich with position')
  t.is(result[0].severity, 'high', 'should preserve alert severity')
})

test('extractAlertsFromThings - skips things without alerts', (t) => {
  const things = [
    { id: 'miner-1', last: {} },
    { id: 'miner-2', last: { alerts: null } },
    { id: 'miner-3' }
  ]

  const result = extractAlertsFromThings(things)
  t.is(result.length, 0, 'should return empty array')
})

test('extractAlertsFromThings - skips invalid alert entries', (t) => {
  const things = [
    {
      id: 'miner-1',
      type: 'miner',
      code: 'S19',
      last: {
        alerts: [null, 'string', [], { severity: 'high' }]
      }
    }
  ]

  const result = extractAlertsFromThings(things)
  t.is(result.length, 1, 'should only include valid object alerts')
})

// ==================== validateFilter Tests ====================

test('validateFilter - returns {} for null/undefined', (t) => {
  t.alike(validateFilter(null, SITE_ALERTS_FILTER_FIELDS, ALERTS_FILTER_OPERATORS), {}, 'null -> {}')
  t.alike(validateFilter(undefined, SITE_ALERTS_FILTER_FIELDS, ALERTS_FILTER_OPERATORS), {}, 'undefined -> {}')
})

test('validateFilter - passes through scalar equality', (t) => {
  const out = validateFilter({ type: 'miner' }, SITE_ALERTS_FILTER_FIELDS, ALERTS_FILTER_OPERATORS)
  t.alike(out, { type: 'miner' }, 'scalar stays as equality')
})

test('validateFilter - normalises bare array to $in', (t) => {
  const out = validateFilter({ severity: ['high', 'critical'] }, SITE_ALERTS_FILTER_FIELDS, ALERTS_FILTER_OPERATORS)
  t.alike(out, { severity: { $in: ['high', 'critical'] } }, 'array -> $in')
})

test('validateFilter - allows whitelisted operators ($ne for operational)', (t) => {
  const out = validateFilter({ type: { $ne: 'miner' } }, SITE_ALERTS_FILTER_FIELDS, ALERTS_FILTER_OPERATORS)
  t.alike(out, { type: { $ne: 'miner' } }, 'keeps $ne')
})

test('validateFilter - throws on disallowed field', (t) => {
  t.exception(
    () => validateFilter({ secret: 'x' }, SITE_ALERTS_FILTER_FIELDS, ALERTS_FILTER_OPERATORS),
    /ERR_INVALID_FILTER/,
    'unknown field is rejected'
  )
})

test('validateFilter - throws on disallowed operator', (t) => {
  t.exception(
    () => validateFilter({ message: { $regex: '.*' } }, SITE_ALERTS_FILTER_FIELDS, ALERTS_FILTER_OPERATORS),
    /ERR_INVALID_FILTER/,
    '$regex is not allowed'
  )
})

test('validateFilter - throws when $in value is not an array', (t) => {
  t.exception(
    () => validateFilter({ type: { $in: 'miner' } }, SITE_ALERTS_FILTER_FIELDS, ALERTS_FILTER_OPERATORS),
    /ERR_INVALID_FILTER/,
    '$in requires an array'
  )
})

// ==================== applyMongoFilter Tests ====================

test('applyMongoFilter - no-op for empty filter', (t) => {
  const items = [{ severity: 'high' }, { severity: 'low' }]
  t.is(applyMongoFilter(items, {}).length, 2, 'empty filter returns all')
})

test('applyMongoFilter - equality and $in', (t) => {
  const items = [{ severity: 'high' }, { severity: 'low' }, { severity: 'critical' }]
  t.is(applyMongoFilter(items, { severity: 'high' }).length, 1, 'equality matches one')
  t.is(applyMongoFilter(items, { severity: { $in: ['high', 'critical'] } }).length, 2, '$in matches two')
})

test('applyMongoFilter - $ne (operational = all except miner)', (t) => {
  const items = [{ type: 'miner' }, { type: 'dcs-siemens' }, { type: 'powermeter' }]
  const operational = applyMongoFilter(items, { type: { $ne: 'miner' } })
  t.is(operational.length, 2, 'excludes miner')
  t.absent(operational.find(a => a.type === 'miner'), 'no miner alerts')
})

// ==================== combineAnd Tests ====================

test('combineAnd - drops empty operands', (t) => {
  t.alike(combineAnd({ a: 1 }, null), { a: 1 }, 'nil right -> left')
  t.alike(combineAnd({}, { b: 2 }), { b: 2 }, 'empty left -> right')
  t.alike(combineAnd({}, null), {}, 'both empty -> {}')
})

test('combineAnd - wraps two non-empty queries in $and', (t) => {
  t.alike(combineAnd({ a: 1 }, { b: 2 }), { $and: [{ a: 1 }, { b: 2 }] }, 'AND of both')
})

// ==================== matchesSearch Tests ====================

test('matchesSearch - returns true when no search', (t) => {
  t.ok(matchesSearch({ id: 'test' }, '', ['id']), 'empty search should match')
  t.ok(matchesSearch({ id: 'test' }, null, ['id']), 'null search should match')
})

test('matchesSearch - case-insensitive substring match', (t) => {
  const item = { id: 'Miner-ABC-123', code: 'S19' }
  t.ok(matchesSearch(item, 'abc', ['id', 'code']), 'should match case-insensitive')
  t.ok(matchesSearch(item, 'S19', ['id', 'code']), 'should match code field')
  t.ok(!matchesSearch(item, 'xyz', ['id', 'code']), 'should not match')
})

test('matchesSearch - handles null/undefined fields', (t) => {
  const item = { id: 'test', code: null }
  t.ok(matchesSearch(item, 'test', ['id', 'code', 'missing']), 'should handle null fields')
})

// ==================== applySort Tests ====================

test('applySort - returns items when no sort', (t) => {
  const items = [{ a: 2 }, { a: 1 }]
  const result = applySort(items, null)
  t.is(result[0].a, 2, 'should preserve order')
})

test('applySort - sorts ascending', (t) => {
  const items = [{ ts: 3 }, { ts: 1 }, { ts: 2 }]
  const result = applySort(items, { ts: 1 })
  t.is(result[0].ts, 1, 'first should be smallest')
  t.is(result[2].ts, 3, 'last should be largest')
})

test('applySort - sorts descending', (t) => {
  const items = [{ ts: 1 }, { ts: 3 }, { ts: 2 }]
  const result = applySort(items, { ts: -1 })
  t.is(result[0].ts, 3, 'first should be largest')
  t.is(result[2].ts, 1, 'last should be smallest')
})

test('applySort - does not mutate original', (t) => {
  const items = [{ ts: 2 }, { ts: 1 }]
  applySort(items, { ts: 1 })
  t.is(items[0].ts, 2, 'original should be unchanged')
})

// ==================== buildSeveritySummary Tests ====================

test('buildSeveritySummary - counts by severity', (t) => {
  const alerts = [
    { severity: 'critical' },
    { severity: 'high' },
    { severity: 'high' },
    { severity: 'medium' },
    { severity: 'low' },
    { severity: 'low' },
    { severity: 'low' }
  ]

  const result = buildSeveritySummary(alerts)
  t.is(result.critical, 1, 'should count critical')
  t.is(result.high, 2, 'should count high')
  t.is(result.medium, 1, 'should count medium')
  t.is(result.low, 3, 'should count low')
  t.is(result.total, 7, 'should count total')
})

test('buildSeveritySummary - empty alerts', (t) => {
  const result = buildSeveritySummary([])
  t.is(result.total, 0, 'total should be 0')
  t.is(result.critical, 0, 'critical should be 0')
})

// ==================== deduplicateAlerts Tests ====================

test('deduplicateAlerts - removes duplicates by uuid', (t) => {
  const alerts = [
    { uuid: 'a', name: 'first' },
    { uuid: 'b', name: 'second' },
    { uuid: 'a', name: 'duplicate' }
  ]

  const result = deduplicateAlerts(alerts)
  t.is(result.length, 2, 'should remove duplicate')
  t.is(result[0].name, 'first', 'should keep first occurrence')
})

test('deduplicateAlerts - keeps alerts without uuid', (t) => {
  const alerts = [
    { name: 'no-uuid-1' },
    { name: 'no-uuid-2' }
  ]

  const result = deduplicateAlerts(alerts)
  t.is(result.length, 2, 'should keep all without uuid')
})

test('deduplicateAlerts - empty array', (t) => {
  const result = deduplicateAlerts([])
  t.is(result.length, 0, 'should return empty array')
})

// ==================== getSiteAlerts Tests ====================

test('getSiteAlerts - happy path', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async () => [
      {
        id: 'miner-1',
        type: 'miner',
        code: 'S19',
        info: { container: 'cont-A' },
        last: {
          alerts: [
            { severity: 'high', name: 'Fan failure' },
            { severity: 'low', name: 'Temp warning' }
          ]
        }
      },
      {
        id: 'miner-2',
        type: 'miner',
        code: 'S21',
        info: { container: 'cont-B' },
        last: {
          alerts: [
            { severity: 'critical', name: 'Overheat' }
          ]
        }
      }
    ]
  )

  const mockReq = { query: {} }
  const result = await getSiteAlerts(mockCtx, mockReq)

  t.ok(result.alerts, 'should return alerts')
  t.ok(result.summary, 'should return summary')
  t.ok(typeof result.total === 'number', 'should return total')
  t.is(result.total, 3, 'should have 3 total alerts')
  t.is(result.summary.miner.critical, 1, 'should count 1 critical under miner')
  t.is(result.summary.miner.high, 1, 'should count 1 high under miner')
  t.is(result.summary.miner.low, 1, 'should count 1 low under miner')
  t.is(result.summary.miner.total, 3, 'miner total covers all alerts')
  t.alike(result.summary.operational, { critical: 0, high: 0, medium: 0, low: 0, total: 0 }, 'operational bucket present and empty')
})

test('getSiteAlerts - empty results', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async () => []
  )

  const mockReq = { query: {} }
  const result = await getSiteAlerts(mockCtx, mockReq)

  t.is(result.total, 0, 'should have 0 total')
  t.is(result.alerts.length, 0, 'should have empty alerts')
  t.alike(result.summary, {
    operational: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
    miner: { critical: 0, high: 0, medium: 0, low: 0, total: 0 }
  }, 'both summary buckets present and zeroed')
})

test('getSiteAlerts - applies filter', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async () => [
      {
        id: 'miner-1',
        type: 'miner',
        code: 'S19',
        info: { container: 'cont-A' },
        last: { alerts: [{ severity: 'high', name: 'Alert 1' }] }
      },
      {
        id: 'miner-2',
        type: 'miner',
        code: 'S21',
        info: { container: 'cont-B' },
        last: { alerts: [{ severity: 'low', name: 'Alert 2' }] }
      }
    ]
  )

  const mockReq = { query: { filter: JSON.stringify({ severity: 'high' }) } }
  const result = await getSiteAlerts(mockCtx, mockReq)

  t.is(result.total, 1, 'should filter to 1 alert')
  t.is(result.alerts[0].severity, 'high', 'should only include high severity')
})

test('getSiteAlerts - applies text search', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async () => [
      {
        id: 'miner-ABC',
        type: 'miner',
        code: 'S19',
        info: { container: 'cont-A' },
        last: { alerts: [{ severity: 'high' }] }
      },
      {
        id: 'miner-XYZ',
        type: 'miner',
        code: 'S21',
        info: { container: 'cont-B' },
        last: { alerts: [{ severity: 'low' }] }
      }
    ]
  )

  const mockReq = { query: { search: 'ABC' } }
  const result = await getSiteAlerts(mockCtx, mockReq)

  t.is(result.total, 1, 'should find 1 match')
  t.is(result.alerts[0].id, 'miner-ABC', 'should match by id')
})

test('getSiteAlerts - applies pagination', async (t) => {
  const things = []
  for (let i = 0; i < 5; i++) {
    things.push({
      id: `miner-${i}`,
      type: 'miner',
      code: 'S19',
      info: { container: 'cont-A' },
      last: { alerts: [{ severity: 'high', name: `Alert ${i}` }] }
    })
  }

  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async () => things
  )

  const mockReq = { query: { offset: '2', limit: '2' } }
  const result = await getSiteAlerts(mockCtx, mockReq)

  t.is(result.total, 5, 'total should be all alerts')
  t.is(result.alerts.length, 2, 'should return limited alerts')
})

// ==================== flattenHistoryAlert Tests ====================

test('flattenHistoryAlert - flattens nested thing structure', (t) => {
  const alert = {
    name: 'hashrate_low',
    severity: 'medium',
    uuid: 'abc',
    createdAt: 1000,
    thing: {
      id: 'miner-1',
      type: 'miner-am-s19xp',
      code: 'AM-S19XP-0104',
      tags: ['t-miner'],
      info: { container: 'cont-A', pos: '1-2_c3' }
    }
  }

  const result = flattenHistoryAlert(alert)
  t.is(result.deviceId, 'miner-1', 'should flatten thing.id to deviceId')
  t.is(result.type, 'miner-am-s19xp', 'should flatten thing.type to type')
  t.is(result.code, 'AM-S19XP-0104', 'should flatten thing.code to code')
  t.is(result.container, 'cont-A', 'should flatten thing.info.container to container')
  t.is(result.position, '1-2_c3', 'should flatten thing.info.pos to position')
  t.ok(Array.isArray(result.tags), 'should flatten thing.tags to tags')
  t.is(result.severity, 'medium', 'should preserve top-level fields')
  t.ok(!result.thing, 'should remove nested thing object')
})

test('flattenHistoryAlert - handles missing thing', (t) => {
  const alert = { name: 'test', severity: 'low', uuid: 'x' }
  const result = flattenHistoryAlert(alert)
  t.is(result.deviceId, undefined, 'deviceId should be undefined')
  t.is(result.container, undefined, 'container should be undefined')
  t.is(result.severity, 'low', 'should preserve severity')
})

// ==================== getAlertsHistory Tests ====================

const makeHistoryAlert = (uuid, createdAt, severity, thingOverrides = {}) => ({
  uuid,
  createdAt,
  severity,
  name: `alert-${uuid}`,
  description: 'Test alert',
  thing: {
    id: `thing-${uuid}`,
    type: 'miner-am-s19xp',
    code: `CODE-${uuid}`,
    tags: ['t-miner'],
    info: { container: 'cont-A', pos: '1-1' },
    ...thingOverrides
  }
})

test('getAlertsHistory - happy path', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async () => [
      makeHistoryAlert('a', 1000, 'high'),
      makeHistoryAlert('b', 2000, 'low')
    ]
  )

  const mockReq = {
    query: { start: 1, end: 3000 }
  }

  const result = await getAlertsHistory(mockCtx, mockReq)

  t.ok(result.alerts, 'should return alerts')
  t.ok(typeof result.total === 'number', 'should return total')
  t.is(result.total, 2, 'should have 2 alerts')
  t.ok(result.alerts[0].deviceId, 'should have flattened deviceId')
  t.ok(result.alerts[0].code, 'should have flattened code')
  t.ok(!result.alerts[0].thing, 'should not have nested thing')
})

test('getAlertsHistory - deduplicates by uuid', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async () => [
      makeHistoryAlert('a', 1000, 'high'),
      makeHistoryAlert('a', 2000, 'high'),
      makeHistoryAlert('b', 3000, 'low')
    ]
  )

  const mockReq = {
    query: { start: 1, end: 5000 }
  }

  const result = await getAlertsHistory(mockCtx, mockReq)

  t.is(result.total, 2, 'should deduplicate to 2 alerts')
})

test('getAlertsHistory - default sort newest first', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async () => [
      makeHistoryAlert('a', 1000, 'high'),
      makeHistoryAlert('b', 3000, 'high'),
      makeHistoryAlert('c', 2000, 'high')
    ]
  )

  const mockReq = {
    query: { start: 1, end: 5000 }
  }

  const result = await getAlertsHistory(mockCtx, mockReq)

  t.is(result.alerts[0].createdAt, 3000, 'newest should be first')
  t.is(result.alerts[2].createdAt, 1000, 'oldest should be last')
})

test('getAlertsHistory - applies filter on flattened fields', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async () => [
      makeHistoryAlert('a', 1000, 'high'),
      makeHistoryAlert('b', 2000, 'low')
    ]
  )

  const mockReq = {
    query: {
      start: 1,
      end: 5000,
      filter: JSON.stringify({ severity: 'high' })
    }
  }

  const result = await getAlertsHistory(mockCtx, mockReq)

  t.is(result.total, 1, 'should filter to 1 alert')
  t.is(result.alerts[0].severity, 'high', 'should only include high severity')
})

test('getAlertsHistory - applies pagination', async (t) => {
  const alerts = []
  for (let i = 0; i < 5; i++) {
    alerts.push(makeHistoryAlert(`u${i}`, i * 1000, 'medium'))
  }

  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async () => alerts
  )

  const mockReq = {
    query: { start: 1, end: 10000, offset: '1', limit: '2' }
  }

  const result = await getAlertsHistory(mockCtx, mockReq)

  t.is(result.total, 5, 'total should be all alerts')
  t.is(result.alerts.length, 2, 'should return limited alerts')
})

test('getAlertsHistory - empty results', async (t) => {
  const mockCtx = createMockCtxWithOrks(
    [{ rpcPublicKey: 'key1' }],
    async () => []
  )

  const mockReq = {
    query: { start: 1, end: 5000 }
  }

  const result = await getAlertsHistory(mockCtx, mockReq)

  t.is(result.total, 0, 'should have 0 total')
  t.is(result.alerts.length, 0, 'should have empty alerts')
})

test('getAlertsHistory - throws on invalid date range', async (t) => {
  const mockCtx = createMockCtxWithOrks()
  const mockReq = {
    query: { start: 5000, end: 1000 }
  }

  try {
    await getAlertsHistory(mockCtx, mockReq)
    t.fail('should have thrown')
  } catch (err) {
    t.is(err.message, 'ERR_INVALID_DATE_RANGE', 'should throw date range error')
  }
})

// ==================== device tag (message) — filter & search ====================

test('extractAlertsFromThings - preserves message (device tag)', (t) => {
  const things = [
    {
      id: 'dcs-1',
      type: 'dcs-siemens',
      code: 'PCS7',
      info: { container: 'cont-A' },
      last: {
        alerts: [
          { severity: 'warning', name: 'flow_warning', message: 'FIT-7513', description: 'Cooling-loop flow below warning threshold — FIT-7513: 320m³/h (threshold 330m³/h)' }
        ]
      }
    }
  ]

  const result = extractAlertsFromThings(things)
  t.is(result[0].message, 'FIT-7513', 'should preserve the device tag in message')
})

test('flattenHistoryAlert - preserves message (device tag)', (t) => {
  const alert = {
    name: 'flow_warning',
    description: 'Cooling-loop flow below warning threshold — FIT-7513: 320m³/h (threshold 330m³/h)',
    severity: 'warning',
    uuid: 'abc',
    createdAt: 1000,
    message: 'FIT-7513',
    thing: { id: 'dcs-1', type: 'dcs-siemens', code: 'PCS7', tags: ['siemens'], info: { container: 'cont-A' } }
  }

  const result = flattenHistoryAlert(alert)
  t.is(result.message, 'FIT-7513', 'should expose the device tag in the history payload')
})

const dcsThings = () => [
  {
    id: 'dcs-1',
    type: 'dcs-siemens',
    code: 'PCS7',
    info: { container: 'cont-A' },
    last: {
      alerts: [
        { severity: 'warning', name: 'flow_warning', message: 'FIT-7513' },
        { severity: 'critical', name: 'flow_alarm', message: 'FIT-7514' }
      ]
    }
  }
]

test('extractAlertsFromThings - exposes deviceId (alias of thing id)', (t) => {
  const things = [
    { id: 'dcs-1', type: 'dcs-siemens', code: 'PCS7', info: {}, last: { alerts: [{ severity: 'high', name: 'flow_alarm' }] } }
  ]
  const result = extractAlertsFromThings(things)
  t.is(result[0].deviceId, 'dcs-1', 'should expose deviceId so the deviceId filter works')
  t.is(result[0].id, 'dcs-1', 'should keep id for backward compatibility')
})

test('getSiteAlerts - filters by deviceId', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => [
    { id: 'dcs-1', type: 'dcs-siemens', code: 'PCS7', info: { container: 'cont-A' }, last: { alerts: [{ severity: 'high', name: 'a1' }] } },
    { id: 'miner-9', type: 'miner', code: 'S19', info: { container: 'cont-B' }, last: { alerts: [{ severity: 'low', name: 'a2' }] } }
  ])
  const mockReq = { query: { filter: JSON.stringify({ deviceId: 'dcs-1' }) } }

  const result = await getSiteAlerts(mockCtx, mockReq)
  t.is(result.total, 1, 'should filter to the one device')
  t.is(result.alerts[0].deviceId, 'dcs-1', 'should return only the dcs-1 alert')
})

test('getSiteAlerts - filters by exact device tag (message)', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => dcsThings())
  const mockReq = { query: { filter: JSON.stringify({ message: 'FIT-7513' }) } }

  const result = await getSiteAlerts(mockCtx, mockReq)
  t.is(result.total, 1, 'should filter to the one matching tag')
  t.is(result.alerts[0].message, 'FIT-7513', 'should return the FIT-7513 alert')
})

test('getSiteAlerts - filters by multiple device tags (array)', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => dcsThings())
  const mockReq = { query: { filter: JSON.stringify({ message: ['FIT-7513', 'FIT-7514'] }) } }

  const result = await getSiteAlerts(mockCtx, mockReq)
  t.is(result.total, 2, 'should match both tags')
})

test('getSiteAlerts - searches by alert name', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => [
    { id: 'm-1', type: 'miner', code: 'S19', info: { container: 'cont-A' }, last: { alerts: [{ severity: 'high', name: 'hashrate_low' }] } },
    { id: 'm-2', type: 'miner', code: 'S21', info: { container: 'cont-B' }, last: { alerts: [{ severity: 'low', name: 'temp_warning' }] } }
  ])
  const result = await getSiteAlerts(mockCtx, { query: { search: 'hashrate' } })
  t.is(result.total, 1, 'should match by alert name')
  t.is(result.alerts[0].name, 'hashrate_low', 'should return the hashrate alert')
})

test('getSiteAlerts - searches by device tag (message)', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => dcsThings())
  const mockReq = { query: { search: 'fit-7514' } }

  const result = await getSiteAlerts(mockCtx, mockReq)
  t.is(result.total, 1, 'should match one alert by tag substring (case-insensitive)')
  t.is(result.alerts[0].message, 'FIT-7514', 'should return the FIT-7514 alert')
})

const dcsHistory = () => [
  {
    uuid: 'h1',
    createdAt: 1000,
    severity: 'warning',
    name: 'flow_warning',
    description: 'Cooling-loop flow below warning threshold — FIT-7513: 320m³/h (threshold 330m³/h)',
    message: 'FIT-7513',
    thing: { id: 'dcs-1', type: 'dcs-siemens', code: 'PCS7', tags: ['siemens'], info: { container: 'cont-A' } }
  },
  {
    uuid: 'h2',
    createdAt: 2000,
    severity: 'critical',
    name: 'flow_alarm',
    description: 'Cooling-loop flow below alarm threshold — FIT-7514: 295m³/h (threshold 300m³/h)',
    message: 'FIT-7514',
    thing: { id: 'dcs-1', type: 'dcs-siemens', code: 'PCS7', tags: ['siemens'], info: { container: 'cont-A' } }
  }
]

test('getAlertsHistory - filters by exact device tag (message)', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => dcsHistory())
  const mockReq = { query: { start: 1, end: 5000, filter: JSON.stringify({ message: 'FIT-7514' }) } }

  const result = await getAlertsHistory(mockCtx, mockReq)
  t.is(result.total, 1, 'should filter history to the matching tag')
  t.is(result.alerts[0].message, 'FIT-7514', 'should return the FIT-7514 history alert')
})

test('getAlertsHistory - searches by device tag (message)', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => dcsHistory())
  const mockReq = { query: { start: 1, end: 5000, search: 'FIT-7513' } }

  const result = await getAlertsHistory(mockCtx, mockReq)
  t.is(result.total, 1, 'should find one history alert by tag')
  t.is(result.alerts[0].message, 'FIT-7513', 'should return the FIT-7513 history alert')
})

// ==================== miner vs operational split ====================

const mixedThings = () => [
  { id: 'miner-1', type: 'miner', code: 'S19', info: { container: 'cont-A' }, last: { alerts: [{ severity: 'high', name: 'hashrate_low' }] } },
  { id: 'dcs-1', type: 'dcs-siemens', code: 'PCS7', info: { container: 'cont-A' }, last: { alerts: [{ severity: 'critical', name: 'flow_alarm' }] } },
  { id: 'pm-1', type: 'powermeter', code: 'PM', info: { container: 'cont-B' }, last: { alerts: [{ severity: 'low', name: 'power_drift' }] } }
]

test('getSiteAlerts - miner alerts only (type equality)', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => mixedThings())
  const mockReq = { query: { filter: JSON.stringify({ type: 'miner' }) } }

  const result = await getSiteAlerts(mockCtx, mockReq)
  t.is(result.total, 1, 'should keep only miner alerts')
  t.is(result.alerts[0].type, 'miner', 'should be a miner alert')
})

test('getSiteAlerts - operational alerts (type $ne miner)', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => mixedThings())
  const mockReq = { query: { filter: JSON.stringify({ type: { $ne: 'miner' } }) } }

  const result = await getSiteAlerts(mockCtx, mockReq)
  t.is(result.total, 2, 'should keep all non-miner alerts')
  t.absent(result.alerts.find(a => a.type === 'miner'), 'should exclude miner alerts')
})

test('getSiteAlerts - throws on invalid filter field', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => mixedThings())
  const mockReq = { query: { filter: JSON.stringify({ bogus: 'x' }) } }

  await t.exception(getSiteAlerts(mockCtx, mockReq), /ERR_INVALID_FILTER/, 'rejects unknown field')
})

const mixedHistory = () => [
  makeHistoryAlert('m1', 1000, 'high', { type: 'miner' }),
  makeHistoryAlert('d1', 2000, 'critical', { type: 'dcs-siemens' }),
  makeHistoryAlert('p1', 3000, 'low', { type: 'powermeter' })
]

test('getAlertsHistory - miner alerts only (type equality)', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => mixedHistory())
  const mockReq = { query: { start: 1, end: 5000, filter: JSON.stringify({ type: 'miner' }) } }

  const result = await getAlertsHistory(mockCtx, mockReq)
  t.is(result.total, 1, 'should keep only miner alerts')
  t.is(result.alerts[0].type, 'miner', 'should be a miner alert')
})

test('getAlertsHistory - operational alerts (type $ne miner)', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => mixedHistory())
  const mockReq = { query: { start: 1, end: 5000, filter: JSON.stringify({ type: { $ne: 'miner' } }) } }

  const result = await getAlertsHistory(mockCtx, mockReq)
  t.is(result.total, 2, 'should keep all non-miner alerts')
  t.absent(result.alerts.find(a => a.type === 'miner'), 'should exclude miner alerts')
})

// ==================== `type` query param (all/operational/miner) ====================

// Includes a subtyped miner ('miner-am-s19xp') to prove the category matches
// miner subtypes, not just the exact 'miner' type.
const typedThings = () => [
  { id: 'miner-1', type: 'miner', code: 'S19', info: { container: 'cont-A' }, last: { alerts: [{ severity: 'high', name: 'a1' }] } },
  { id: 'miner-2', type: 'miner-am-s19xp', code: 'S21', info: { container: 'cont-A' }, last: { alerts: [{ severity: 'low', name: 'a2' }] } },
  { id: 'dcs-1', type: 'dcs-siemens', code: 'PCS7', info: { container: 'cont-B' }, last: { alerts: [{ severity: 'critical', name: 'a3' }] } },
  { id: 'pm-1', type: 'powermeter', code: 'PM', info: { container: 'cont-B' }, last: { alerts: [{ severity: 'medium', name: 'a4' }] } }
]

test('getSiteAlerts - type=all returns everything', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => typedThings())
  const result = await getSiteAlerts(mockCtx, { query: { type: 'all' } })
  t.is(result.total, 4, 'all alerts')
})

test('getSiteAlerts - no type returns everything', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => typedThings())
  const result = await getSiteAlerts(mockCtx, { query: {} })
  t.is(result.total, 4, 'all alerts when type omitted')
})

test('getSiteAlerts - type=miner keeps miner + subtypes', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => typedThings())
  const result = await getSiteAlerts(mockCtx, { query: { type: 'miner' } })
  t.is(result.total, 2, 'miner and miner-am-s19xp')
  t.ok(result.alerts.every(a => a.type.startsWith('miner')), 'only miner-family alerts')
})

test('getSiteAlerts - type=operational excludes miner family', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => typedThings())
  const result = await getSiteAlerts(mockCtx, { query: { type: 'operational' } })
  t.is(result.total, 2, 'dcs + powermeter')
  t.absent(result.alerts.find(a => a.type.startsWith('miner')), 'no miner alerts')
})

test('getSiteAlerts - type combines with existing filter (AND)', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => typedThings())
  // operational + severity=critical -> only the dcs critical alert
  const mockReq = { query: { type: 'operational', filter: JSON.stringify({ severity: 'critical' }) } }
  const result = await getSiteAlerts(mockCtx, mockReq)
  t.is(result.total, 1, 'AND of type and filter')
  t.is(result.alerts[0].id, 'dcs-1', 'the critical operational alert')
})

test('getSiteAlerts - listThings always fetches the full alerted set (type applied post-merge)', async (t) => {
  let captured
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async (_pk, method, params) => {
    // getSiteAlerts also reads worker ext data via getWrkExtData; only capture
    // the listThings call this assertion is about.
    if (method === 'listThings') captured = params
    return typedThings()
  })
  const result = await getSiteAlerts(mockCtx, { query: { type: 'operational' } })
  t.alike(captured.query, { 'last.alerts': { $ne: null } },
    'query stays unfiltered so the summary covers the full set')
  t.is(result.total, 2, 'type still narrows the returned list')
})

const typedHistory = () => [
  makeHistoryAlert('m1', 1000, 'high', { type: 'miner' }),
  makeHistoryAlert('m2', 2000, 'low', { type: 'miner-am-s19xp' }),
  makeHistoryAlert('d1', 3000, 'critical', { type: 'dcs-siemens' }),
  makeHistoryAlert('p1', 4000, 'medium', { type: 'powermeter' })
]

test('getAlertsHistory - type=miner keeps miner + subtypes', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => typedHistory())
  const result = await getAlertsHistory(mockCtx, { query: { start: 1, end: 9000, type: 'miner' } })
  t.is(result.total, 2, 'miner and miner-am-s19xp')
  t.ok(result.alerts.every(a => a.type.startsWith('miner')), 'only miner-family alerts')
})

test('getAlertsHistory - type=operational excludes miner family', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => typedHistory())
  const result = await getAlertsHistory(mockCtx, { query: { start: 1, end: 9000, type: 'operational' } })
  t.is(result.total, 2, 'dcs + powermeter')
  t.absent(result.alerts.find(a => a.type.startsWith('miner')), 'no miner alerts')
})

test('getAlertsHistory - type=all returns everything', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => typedHistory())
  const result = await getAlertsHistory(mockCtx, { query: { start: 1, end: 9000, type: 'all' } })
  t.is(result.total, 4, 'all alerts')
})

test('getAlertsHistory - type pushes thing.type constraint to the worker query', async (t) => {
  let captured
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async (_pk, method, params) => {
    // getAlertsHistory also reads worker ext data via getWrkExtData; only capture
    // the getHistoricalLogs call this assertion is about.
    if (method === 'getHistoricalLogs') captured = params
    return typedHistory()
  })
  await getAlertsHistory(mockCtx, { query: { start: 1, end: 9000, type: 'miner' } })
  t.alike(captured.query, { 'thing.type': { $regex: '^miner(-|$)' } }, 'miner constraint pushed to getHistoricalLogs')
})

// ==================== Worker-level alert merge (ext data) ====================

const oceanExtAlert = (createdAt = 1000, uuid = 'datum-uuid-1') => ({
  name: 'Datum_Offline',
  code: 'ocean',
  description: 'DATUM gateway is offline',
  severity: 'critical',
  createdAt,
  uuid,
  id: 'minerpool-ocean',
  deviceId: 'minerpool-ocean',
  type: 'minerpool',
  container: null,
  position: null
})

test('getSiteAlerts - merges worker-level alerts from ext data', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async (_pk, method) => {
    if (method === 'listThings') {
      return [{ id: 'm1', type: 'miner', code: 'S19', info: {}, last: { alerts: [{ severity: 'high', name: 'fan' }] } }]
    }
    if (method === 'getWrkExtData') return [{ ts: 1000, alerts: [oceanExtAlert()] }]
    return []
  })
  const result = await getSiteAlerts(mockCtx, { query: {} })
  t.ok(result.alerts.some(a => a.name === 'Datum_Offline'), 'worker alert merged into site alerts')
  t.ok(result.alerts.some(a => a.name === 'fan'), 'thing alert still present')
  t.is(result.summary.operational.critical, 1, 'critical worker alert counted under operational')
  t.is(result.summary.miner.high, 1, 'thing alert counted under miner')
})

test('getSiteAlerts - worker alerts respect the type filter (minerpool is operational)', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async (_pk, method) => {
    if (method === 'getWrkExtData') return [{ ts: 1000, alerts: [oceanExtAlert()] }]
    return []
  })
  const operational = await getSiteAlerts(mockCtx, { query: { type: 'operational' } })
  t.ok(operational.alerts.some(a => a.name === 'Datum_Offline'), 'kept under operational')
  const miner = await getSiteAlerts(mockCtx, { query: { type: 'miner' } })
  t.absent(miner.alerts.find(a => a.name === 'Datum_Offline'), 'excluded under miner')
})

test('getAlertsHistory - merges worker-level alert history from ext data', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async (_pk, method) => {
    if (method === 'getHistoricalLogs') return [makeHistoryAlert('m1', 1000, 'high', { type: 'miner' })]
    if (method === 'getWrkExtData') return [{ ts: 5000, alerts: [oceanExtAlert(5000, 'datum-uuid-2')] }]
    return []
  })
  const result = await getAlertsHistory(mockCtx, { query: { start: 1, end: 9000 } })
  t.ok(result.alerts.some(a => a.name === 'Datum_Offline'), 'worker history alert merged')
  t.ok(result.alerts.some(a => a.type === 'miner'), 'thing history alert still present')
})

test('getAlertsHistory - dedupes repeated worker alerts by uuid', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async (_pk, method) => {
    if (method === 'getHistoricalLogs') return []
    // same alert reported in two buckets (same uuid)
    if (method === 'getWrkExtData') return [{ ts: 5000, alerts: [oceanExtAlert(5000, 'dup')] }, { ts: 6000, alerts: [oceanExtAlert(5000, 'dup')] }]
    return []
  })
  const result = await getAlertsHistory(mockCtx, { query: { start: 1, end: 9000 } })
  t.is(result.alerts.filter(a => a.uuid === 'dup').length, 1, 'duplicate uuid collapsed to one')
})

// ==================== structured DCS fields (deviceTag / metadata) ====================

test('extractAlertsFromThings - preserves deviceTag and metadata', (t) => {
  const things = [
    {
      id: 'dcs-1',
      type: 'dcs-siemens',
      code: 'PCS7',
      info: { container: 'cont-A' },
      last: {
        alerts: [
          {
            severity: 'critical',
            name: 'temperature_alarm',
            message: 'PUMP_01',
            deviceTag: 'PUMP_01',
            metadata: { value: 45.5, threshold: 45, unit: '°C' }
          }
        ]
      }
    }
  ]

  const result = extractAlertsFromThings(things)
  t.is(result[0].deviceTag, 'PUMP_01', 'should preserve deviceTag')
  t.alike(result[0].metadata, { value: 45.5, threshold: 45, unit: '°C' }, 'should preserve metadata')
})

test('getSiteAlerts - DCS alerts expose deviceTag and metadata', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => [
    {
      id: 'dcs-1',
      type: 'dcs-siemens',
      code: 'PCS7',
      info: { container: 'cont-A' },
      last: {
        alerts: [
          { severity: 'critical', name: 'flow_alarm', message: 'FIT-7514', deviceTag: 'FIT-7514', metadata: { value: 295, threshold: 300, unit: 'm³/h' } }
        ]
      }
    }
  ])
  const result = await getSiteAlerts(mockCtx, { query: {} })
  t.is(result.alerts[0].deviceTag, 'FIT-7514', 'deviceTag flows through to the response')
  t.alike(result.alerts[0].metadata, { value: 295, threshold: 300, unit: 'm³/h' }, 'metadata flows through to the response')
})

// ==================== buildSiteAlertsSummary ====================

test('buildSiteAlertsSummary - splits miner family from operational', (t) => {
  const alerts = [
    { type: 'miner', severity: 'high' },
    { type: 'miner-am-s19xp', severity: 'critical' },
    { type: 'dcs-siemens', severity: 'critical' },
    { type: 'powermeter', severity: 'low' },
    { type: 'minerpool', severity: 'medium' }
  ]

  const result = buildSiteAlertsSummary(alerts)
  t.alike(result.miner, { critical: 1, high: 1, medium: 0, low: 0, total: 2 }, 'miner + subtype counted under miner')
  t.alike(result.operational, { critical: 1, high: 0, medium: 1, low: 1, total: 3 }, 'non-miner types counted under operational')
})

test('buildSiteAlertsSummary - alert without type falls under operational', (t) => {
  const result = buildSiteAlertsSummary([{ severity: 'high' }])
  t.is(result.operational.total, 1, 'typeless alert lands in operational')
  t.is(result.miner.total, 0, 'miner bucket untouched')
})

// ==================== summary over the full set (ignores filter/search/type) ====================

test('getSiteAlerts - summary ignores filter, search and type params', async (t) => {
  const fullSummary = {
    operational: { critical: 1, high: 0, medium: 1, low: 0, total: 2 },
    miner: { critical: 0, high: 1, medium: 0, low: 1, total: 2 }
  }
  const queries = [
    {},
    { filter: JSON.stringify({ severity: 'critical' }) },
    { filter: JSON.stringify({ type: 'dcs-siemens' }) },
    { search: 'a1' },
    { type: 'miner' },
    { type: 'operational' }
  ]

  for (const query of queries) {
    const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => typedThings())
    const result = await getSiteAlerts(mockCtx, { query })
    t.alike(result.summary, fullSummary, `summary stays global for ${JSON.stringify(query)}`)
  }
})

test('getSiteAlerts - filter on type narrows alerts and total but not summary', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => typedThings())
  const result = await getSiteAlerts(mockCtx, { query: { filter: JSON.stringify({ type: 'dcs-siemens' }) } })

  t.is(result.total, 1, 'total reflects the filtered list')
  t.ok(result.alerts.every(a => a.type === 'dcs-siemens'), 'only dcs alerts returned')
  t.is(result.summary.miner.total, 2, 'miner summary still covers filtered-out alerts')
  t.is(result.summary.operational.total, 2, 'operational summary still covers the full set')
})

test('getSiteAlerts - miner alerts never counted under operational', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => [
    { id: 'miner-1', type: 'miner', code: 'S19', info: {}, last: { alerts: [{ severity: 'critical', name: 'a1' }] } },
    { id: 'miner-2', type: 'miner-am-s19xp', code: 'S21', info: {}, last: { alerts: [{ severity: 'critical', name: 'a2' }] } }
  ])
  const result = await getSiteAlerts(mockCtx, { query: {} })
  t.is(result.summary.miner.critical, 2, 'both miner-family alerts under miner')
  t.is(result.summary.operational.total, 0, 'nothing leaks into operational')
})

// ==================== severity-rank sort ====================

test('applySort - severity sorts by rank, not alphabetically', (t) => {
  const items = [{ severity: 'medium' }, { severity: 'critical' }, { severity: 'low' }, { severity: 'high' }]

  const desc = applySort(items, { severity: -1 })
  t.alike(desc.map(a => a.severity), ['critical', 'high', 'medium', 'low'], '-1 orders most severe first')

  const asc = applySort(items, { severity: 1 })
  t.alike(asc.map(a => a.severity), ['low', 'medium', 'high', 'critical'], '1 reverses the order')
})

test('applySort - unknown severity ranks below low', (t) => {
  const items = [{ severity: 'warning' }, { severity: 'low' }, { severity: 'critical' }]
  const desc = applySort(items, { severity: -1 })
  t.alike(desc.map(a => a.severity), ['critical', 'low', 'warning'], 'unrecognised severity sorts last on desc')
})

test('getSiteAlerts - sort by severity rank descending', async (t) => {
  const mockCtx = createMockCtxWithOrks([{ rpcPublicKey: 'key1' }], async () => [
    { id: 'm1', type: 'miner', code: 'S19', info: {}, last: { alerts: [{ severity: 'low', name: 'a1' }] } },
    { id: 'm2', type: 'miner', code: 'S19', info: {}, last: { alerts: [{ severity: 'critical', name: 'a2' }] } },
    { id: 'm3', type: 'miner', code: 'S19', info: {}, last: { alerts: [{ severity: 'medium', name: 'a3' }] } },
    { id: 'm4', type: 'miner', code: 'S19', info: {}, last: { alerts: [{ severity: 'high', name: 'a4' }] } }
  ])
  const result = await getSiteAlerts(mockCtx, { query: { sort: JSON.stringify({ severity: -1 }) } })
  t.alike(result.alerts.map(a => a.severity), ['critical', 'high', 'medium', 'low'], 'critical first with severity:-1')
})
