'use strict'

const mingo = require('mingo')
const {
  RPC_METHODS,
  STATUS_CODES,
  WORKER_TAGS,
  WORKER_TYPES,
  CONTAINER_LIST_FIELDS,
  CABINET_DEVICE_FIELDS
} = require('../../constants')
const { parseJsonQueryParam, flattenRpcResults, escapeRegex } = require('../../utils')
const { assertSafeMongoQuery, buildSearchQuery, sortItems } = require('../lib/queryUtils')

const CABINET_TAGS_QUERY = {
  tags: { $in: [WORKER_TAGS.POWERMETER, WORKER_TAGS.SENSOR, WORKER_TAGS.TEMP_SENSOR] }
}

const CABINET_SEARCH_FIELDS = ['id', 'code', 'type', 'info.pos']
const CABINET_DEFAULT_SORT = { id: 1 }

function parseListQuery (req) {
  const filter = req.query.filter ? parseJsonQueryParam(req.query.filter, 'ERR_FILTER_INVALID_JSON') : null
  if (filter) assertSafeMongoQuery(filter)
  const sort = req.query.sort ? parseJsonQueryParam(req.query.sort, 'ERR_SORT_INVALID_JSON') : null
  if (sort) assertSafeMongoQuery(sort)

  return {
    filter,
    sort,
    fields: req.query.fields ? parseJsonQueryParam(req.query.fields, 'ERR_FIELDS_INVALID_JSON') : null,
    search: req.query.search || null,
    offset: Number(req.query.offset) || 0,
    limit: Number(req.query.limit) || 0
  }
}

function buildMingoFilter (filter, search) {
  if (!filter && !search) return {}

  const escaped = search ? escapeRegex(search) : null
  const searchFilter = escaped
    ? {
        $or: [
          { id: { $regex: escaped, $options: 'i' } },
          { ip: { $regex: escaped, $options: 'i' } }
        ]
      }
    : null

  if (!filter) return searchFilter
  if (!searchFilter) return filter
  return { $and: [filter, searchFilter] }
}

function queryAndPaginate (items, { filter, fields, sort, search, offset, limit }) {
  const mingoFilter = buildMingoFilter(filter, search)
  const query = new mingo.Query(mingoFilter)
  let cursor = query.find(items, fields || {})
  if (sort) cursor = cursor.sort(sort)
  const filtered = cursor.all()

  const total = filtered.length
  const page = (offset || limit)
    ? filtered.slice(offset, limit ? offset + limit : undefined)
    : filtered

  return { page, total }
}

function collectFilterPaths (filter, paths = new Set()) {
  if (!filter || typeof filter !== 'object') return paths

  if (Array.isArray(filter)) {
    for (const item of filter) collectFilterPaths(item, paths)
    return paths
  }

  for (const [key, value] of Object.entries(filter)) {
    if (!key.startsWith('$')) paths.add(key)
    collectFilterPaths(value, paths)
  }
  return paths
}

/**
 * Ork projection for the containers list. Fetching happens before the
 * user filter/sort run app-side, so their paths must be projected too.
 */
function buildContainerProjection ({ fields, sort, filter }) {
  const requested = fields
    ? Object.fromEntries(Object.entries(fields).filter(([, value]) => value === 1))
    : null
  const projection = {
    id: 1,
    type: 1,
    tags: 1,
    ...(requested && Object.keys(requested).length ? requested : CONTAINER_LIST_FIELDS)
  }
  if (sort) {
    for (const path of Object.keys(sort)) projection[path] = 1
  }
  for (const path of collectFilterPaths(filter)) projection[path] = 1
  return projection
}

async function getContainers (ctx, req) {
  const params = parseListQuery(req)

  const results = await ctx.dataProxy.requestDataAllPages(RPC_METHODS.LIST_THINGS, {
    query: { tags: { $in: [WORKER_TAGS.CONTAINER] } },
    fields: buildContainerProjection(params)
  })

  const items = flattenRpcResults(results)
  const { page: containers, total } = queryAndPaginate(items, { ...params, fields: null })

  return { containers, total }
}

async function getCabinets (ctx, req) {
  const { filter, sort, search, offset, limit } = parseListQuery(req)

  const results = await ctx.dataProxy.requestDataAllPages(RPC_METHODS.LIST_THINGS, {
    query: CABINET_TAGS_QUERY,
    fields: CABINET_DEVICE_FIELDS
  })

  let devices = flattenRpcResults(results)

  if (filter || search) {
    const deviceFilter = search
      ? filter
        ? { $and: [filter, buildSearchQuery(search, CABINET_SEARCH_FIELDS)] }
        : buildSearchQuery(search, CABINET_SEARCH_FIELDS)
      : filter
    devices = new mingo.Query(deviceFilter).find(devices).all()
  }

  let cabinets = groupIntoCabinets(devices)
  cabinets = sortItems(cabinets, sort || CABINET_DEFAULT_SORT)

  const total = cabinets.length
  if (offset || limit) {
    cabinets = cabinets.slice(offset, limit ? offset + limit : undefined)
  }

  return { cabinets, total }
}

async function getCabinetById (ctx, req) {
  const cabinetId = req.params.id

  const results = await ctx.dataProxy.requestDataAllPages(RPC_METHODS.LIST_THINGS, {
    query: {
      $and: [
        { 'info.pos': { $regex: `^${escapeRegex(cabinetId)}(_|$)` } },
        CABINET_TAGS_QUERY
      ]
    },
    fields: CABINET_DEVICE_FIELDS
  })

  const devices = flattenRpcResults(results)
  const cabinets = groupIntoCabinets(devices)
  const cabinet = cabinets.find(c => c.id === cabinetId)

  if (!cabinet) {
    const err = new Error('ERR_CABINET_NOT_FOUND')
    err.statusCode = STATUS_CODES.NOT_FOUND
    throw err
  }

  return { cabinet }
}

function getCabinetPos (device) {
  const [root, devicePos] = String(device?.info?.pos || '').split('_')
  return { root, devicePos }
}

const isPowerMeterType = (type) => String(type || '').startsWith('powermeter-')
const isTempSensorType = (type) => String(type || '').startsWith('sensor-temp-')
const isTransformerTempSensorPos = (devicePos) => String(devicePos || '').startsWith('tr')

/**
 * Groups power meter / temp sensor devices into LV cabinet entities keyed by
 * the root segment of info.pos ('lv1_pm2' -> cabinet 'lv1'). Devices that are
 * neither power meters nor temp sensors pass through ungrouped.
 */
function groupIntoCabinets (devices) {
  const groups = new Map()
  const otherDevices = []

  for (const device of devices) {
    if (!isPowerMeterType(device?.type) && !isTempSensorType(device?.type)) {
      otherDevices.push(device)
      continue
    }
    const { root } = getCabinetPos(device)
    if (!root || !root.trim()) continue
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(device)
  }

  const cabinets = []
  for (const [root, group] of groups) {
    const cabinet = {
      id: root,
      type: WORKER_TYPES.CABINET,
      powerMeters: [],
      tempSensors: [],
      connectedDevices: [],
      alerts: [],
      comments: []
    }
    const connected = new Set()

    for (const device of group) {
      const { root: deviceRoot, devicePos } = getCabinetPos(device)
      const isTemp = isTempSensorType(device.type)
      const isPower = isPowerMeterType(device.type)
      const isRoot = deviceRoot === devicePos

      if (isTemp) {
        if (isRoot) cabinet.rootTempSensor = device
        else cabinet.tempSensors.push(device)
      }
      if (isPower) {
        if (isRoot) cabinet.rootPowerMeter = device
        else cabinet.powerMeters.push(device)
      }
      if (isTransformerTempSensorPos(devicePos)) cabinet.transformerTempSensor = device

      for (const connectedDevice of device.info?.connectedDevices || []) {
        connected.add(connectedDevice)
      }

      if (Array.isArray(device.last?.alerts)) {
        cabinet.alerts = device.last.alerts
          .map(alert => ({ ...alert, sensorData: device }))
          .concat(cabinet.alerts)
      }

      if (Array.isArray(device.comments)) {
        for (const comment of device.comments) {
          cabinet.comments.push({
            ...comment,
            pos: device.info?.pos,
            type: device.type,
            thingId: device.id,
            rackId: device.rack
          })
        }
      }

      cabinet.code = device.code
      cabinet.rack = device.rack
      cabinet.thingId = device.id
    }

    cabinet.connectedDevices = [...connected]
    cabinets.push(cabinet)
  }

  return [...cabinets, ...otherDevices]
}

module.exports = {
  getContainers,
  getCabinets,
  getCabinetById,
  groupIntoCabinets,
  getCabinetPos,
  collectFilterPaths,
  buildContainerProjection,
  parseListQuery,
  buildMingoFilter,
  queryAndPaginate
}
