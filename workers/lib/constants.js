'use strict'

const GLOBAL_DATA_TYPES = {
  PRODUCTION_COSTS: 'productionCosts',
  COST_PARAMETERS: 'costParameters',
  FEATURES: 'features',
  SITE_ENERGY: 'siteEnergy',
  CONTAINER_SETTINGS: 'containerSettings'
}

const LCOE_SOURCES = ['current', 'custom']

const USER_SETTINGS_TYPE = 'userSettings'

const SUPER_ADMIN_ID = '1'
const SUPER_ADMIN_ROLE = '*'

const MIGRATED_USER_ROLES = {
  DEFAULT: 'site_operator',
  READ_ONLY: 'read_only_user'
}

const AUTH_PERMISSIONS = {
  MINER: 'miner',
  CONTAINER: 'container',
  MINERPOOL: 'minerpool',
  POWERMETER: 'powermeter',
  TEMP: 'temp',
  ELECTRICITY: 'electricity',
  FEATURES: 'features',
  REVENUE: 'revenue',
  ACTIONS: 'actions',
  USERS: 'users',
  PRODUCTION: 'production',
  ALERTS: 'alerts',
  CABINETS: 'cabinets',
  COMMENTS: 'comments',
  EXPLORER: 'explorer',
  INVENTORY: 'inventory',
  REPORTING: 'reporting',
  SETTINGS: 'settings',
  TICKETS: 'tickets',
  FORECAST: 'forecast',
  POOL_CONFIG: 'pool_config',
  POOL_CONFIG_APPROVE: 'pool_config_approve',
  WORK_ORDER: 'work_order'
}

const WORK_ORDER_THING_TYPE = 'inventory-work_order'

const WORK_ORDER_TYPES = { REGISTER: 1, MOVE: 2, MICROBT_MINER: 3, MICROBT_NON_MINER: 4 }
const WORK_ORDER_TERMINAL_STATUSES = ['closed', 'cancelled']
const WORK_ORDER_VALID_DEVICE_TYPES = ['miner', 'psu', 'hashboard', 'controller']
const MINER_LOCATIONS = ['workshop.warehouse', 'workshop.lab', 'site.warehouse', 'site.lab', 'site.container', 'miner.room', 'vendor', 'emca.container', 'scrapped', 'disposed', 'unknown']
const MINER_ROOM_LOCATION = 'miner.room'
const MAINTENANCE_CONTAINER = 'maintenance'
const SPARE_PART_INITIAL_LOCATION = 'site.warehouse'
const FILE_TYPES = { WORK_ORDER: 'work_order' }
const WORK_ORDER_ACTION_WAIT_ATTEMPTS = 8
const WORK_ORDER_ACTION_WAIT_MS = 1000
const WORK_ORDER_FILE_MAX_BYTES_DEFAULT = 10 * 1024 * 1024
const WORK_ORDER_FILE_COUNT_CAP_DEFAULT = 20
const WORK_ORDER_FILE_MIME_ALLOWLIST_DEFAULT = [
  'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/pdf', 'text/plain', 'text/csv', 'application/json'
]

const AUTH_LEVELS = {
  READ: 'r',
  WRITE: 'w'
}

const AUTH_CAPS = Object.freeze({
  m: 'miner',
  c: 'container',
  mp: 'minerpool',
  p: 'powermeter',
  t: 'temp',
  e: 'electricity',
  f: 'features',
  r: 'revenue'
})

const COMMENT_ACTION = {
  ADD: 'saveThingComment',
  EDIT: 'editThingComment',
  DELETE: 'deleteThingComment'
}

const ENDPOINTS = {
  // OAuth endpoints
  OAUTH_GOOGLE_CALLBACK: '/oauth/google/callback',
  OAUTH_MICROSOFT_CALLBACK: '/oauth/microsoft/callback',

  // Auth endpoints
  USERINFO: '/auth/userinfo',
  TOKEN: '/auth/token',
  PERMISSIONS: '/auth/permissions',
  EXT_DATA: '/auth/ext-data',

  // User endpoints
  USERS: '/auth/users',
  USERS_DELETE: '/auth/users/delete',
  USER_SETTINGS: '/auth/user/settings',
  ROLES_PERMISSIONS: '/auth/roles/permissions',

  // Global endpoints
  GLOBAL_CONFIG: '/auth/global-config',
  GLOBAL_DATA: '/auth/global/data',
  FEATURE_CONFIG: '/auth/featureConfig',
  FEATURES: '/auth/features',
  SITE: '/auth/site',

  // Actions endpoints
  ACTIONS: '/auth/actions',
  ACTIONS_BATCH: '/auth/actions/batch',
  ACTIONS_SINGLE: '/auth/actions/:type/:id',
  ACTIONS_VOTING: '/auth/actions/voting',
  ACTIONS_VOTING_BATCH: '/auth/actions/voting/batch',
  ACTIONS_VOTE: '/auth/actions/voting/:id/vote',
  ACTIONS_CANCEL: '/auth/actions/voting/cancel',
  DOWNLOAD_LOGS: '/auth/download-logs/:id',

  // Generic data-export endpoint (type-discriminated, streams CSV/JSON)
  EXPORT: '/auth/export',

  // Miner log download flow (start → poll status → stream file)
  MINER_DOWNLOAD_LOGS_START: '/auth/miners/:minerId/download-logs',
  MINER_DOWNLOAD_LOGS_STATUS: '/auth/miners/:minerId/download-logs/:jobId/status',
  MINER_DOWNLOAD_LOGS_FILE: '/auth/miners/:minerId/download-logs/:jobId/file',

  // Logs endpoints
  TAIL_LOG: '/auth/tail-log',
  TAIL_LOG_MULTI: '/auth/tail-log/multi',
  TAIL_LOG_RANGE_AGGR: '/auth/tail-log/range-aggr',
  HISTORY_LOG: '/auth/history-log',

  // Things endpoints
  LIST_THINGS: '/auth/list-things',
  LIST_RACKS: '/auth/list-racks',
  THING_COMMENT: '/auth/thing/comment',
  SETTINGS: '/auth/settings',
  WORKER_CONFIG: '/auth/worker-config',
  THING_CONFIG: '/auth/thing-config',
  PDU_LAYOUT: '/auth/pdu-layout',

  // WebSocket endpoint
  WEBSOCKET: '/ws',

  // Finance endpoints
  FINANCE_ENERGY_BALANCE: '/auth/finance/energy-balance',
  FINANCE_EBITDA: '/auth/finance/ebitda',
  FINANCE_COST_SUMMARY: '/auth/finance/cost-summary',
  FINANCE_SUBSIDY_FEES: '/auth/finance/subsidy-fees',
  FINANCE_REVENUE: '/auth/finance/revenue',
  FINANCE_REVENUE_SUMMARY: '/auth/finance/revenue-summary',
  FINANCE_HASH_REVENUE: '/auth/finance/hash-revenue',
  FINANCE_POWER_COST: '/auth/finance/power-cost',

  // Pools endpoints
  POOLS: '/auth/pools',
  POOLS_BALANCE_HISTORY: '/auth/pools/:pool/balance-history',
  POOLS_THING_CONFIG: '/auth/pools/config/:id',
  POOLS_CONTAINERS_STATS: '/auth/pools/stats/containers',

  SITE_STATUS_LIVE: '/auth/site/status/live',
  SITE_POWER_CONSUMPTION: '/auth/site/power-consumption',

  // Generic Config endpoints (type passed as parameter)
  // Note: Config mutations (register, update, delete) go through pushAction endpoint
  CONFIGS: '/auth/configs/:type',
  // Device listing endpoints
  CONTAINERS: '/auth/containers',
  CABINETS: '/auth/cabinets',
  CABINET_BY_ID: '/auth/cabinets/:id',

  // Metrics endpoints
  METRICS_HASHRATE: '/auth/metrics/hashrate',
  METRICS_CONSUMPTION: '/auth/metrics/consumption',
  METRICS_EFFICIENCY: '/auth/metrics/efficiency',
  METRICS_MINER_STATUS: '/auth/metrics/miner-status',
  METRICS_MINERS_BY_CONTAINER: '/auth/metrics/miners/by-container',
  METRICS_MINERS_BY_TYPE: '/auth/metrics/miners/by-type',
  METRICS_INVENTORY_MINER_DISTRIBUTION: '/auth/metrics/inventory/miner-distribution',
  METRICS_SITE_SUMMARY: '/auth/metrics/site/summary',
  METRICS_INVENTORY_SUMMARY: '/auth/metrics/inventory/summary',
  METRICS_REVENUE_HOURLY: '/auth/metrics/revenue/hourly',
  METRICS_POWER_MODE: '/auth/metrics/power-mode',
  METRICS_POWER_MODE_TIMELINE: '/auth/metrics/power-mode/timeline',
  METRICS_TEMPERATURE: '/auth/metrics/temperature',
  METRICS_COOLING: '/auth/metrics/cooling',
  METRICS_CONTAINER_TELEMETRY: '/auth/metrics/containers/:id',
  METRICS_CONTAINER_HISTORY: '/auth/metrics/containers/:id/history',

  // Groups endpoints
  MINERS_GROUPS_STATS: '/auth/miners/groups/stats',

  // Alerts endpoints
  ALERTS_SITE: '/auth/alerts/site',
  ALERTS_HISTORY: '/auth/alerts/history',

  MINERS: '/auth/miners',
  CONTAINER_MINERS: '/auth/containers/:id/miners',
  LIST_FIRMWARES: '/auth/list-firmwares',
  // Cooling System endpoints
  COOLING_SYSTEM: '/auth/dcs/cooling-system',
  // Energy System endpoints
  ENERGY_SYSTEM: '/auth/dcs/energy-system',
  // Site Overview endpoints
  SITE_OVERVIEW_GROUPS: '/auth/site/overview/groups',
  SITE_OVERVIEW_UNITS: '/auth/site/overview/units',
  // Site Efficiency endpoint
  SITE_EFFICIENCY: '/auth/site/efficiency',
  // Explorer endpoints
  EXPLORER_RACKS: '/auth/explorer/racks',
  // Energy endpoints
  ENERGY_FORECAST: '/auth/energy/forecast',
  ENERGY_FORECAST_HISTORY: '/auth/energy/forecast/history',
  ENERGY_FORECAST_SETTINGS: '/auth/energy/forecast/settings',
  ENERGY_FORECAST_OVERRIDE: '/auth/energy/forecast/override',
  ENERGY_AVAILABLE: '/auth/energy/available',
  // Work Order endpoints
  WORK_ORDERS: '/auth/work-orders',
  WORK_ORDERS_BATCH: '/auth/work-orders/batch',
  WORK_ORDER_BY_ID: '/auth/work-orders/:id',
  WORK_ORDER_AUDIT: '/auth/work-orders/:id/audit',
  WORK_ORDER_LOG: '/auth/work-orders/:id/log',
  WORK_ORDER_FILES: '/auth/work-orders/:id/files',
  WORK_ORDER_FILE_BY_ID: '/auth/work-orders/:id/files/:fileId',
  WORK_ORDER_ASSIGN: '/auth/work-orders/:id/assign',
  WORK_ORDER_CLOSE: '/auth/work-orders/:id/close',
  WORK_ORDER_CANCEL: '/auth/work-orders/:id/cancel',
  WORK_ORDER_REOPEN: '/auth/work-orders/:id/reopen',
  // Spare Part endpoints
  SPARE_PARTS: '/auth/spare-parts',
  SPARE_PARTS_BATCH: '/auth/spare-parts/batch',
  SPARE_PART_BY_ID: '/auth/spare-parts/:id',
  SPARE_PART_REPAIR_HISTORY: '/auth/spare-parts/:id/repair-history',
  // Work Order export
  WORK_ORDER_EXPORT: '/auth/work-orders/:id/export',
  WORK_ORDER_EXPORT_RMA: '/auth/work-orders/export/rma'
}

const WORK_ORDER_EXPORT_FORMATS = ['pdf', 'csv', 'docx']

const RMA_COLUMNS = [
  'Ticket',
  'Repaired type',
  'Repaired Miner Sn',
  'Repaired Mac/HB SN/PSU SN',
  'Replaced Mac/HB SN/PSU SN',
  'Repaired Analyze',
  'Repaired Treatment',
  'Remark',
  'Miner Model',
  'Repair Date',
  'Engineer'
]

const MINER_MODEL_DISPLAY_NAMES = {
  'miner-wm-m63spp': 'M63S'
}

const HTTP_METHODS = {
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  DELETE: 'DELETE',
  PATCH: 'PATCH'
}

const OPERATIONS = {
  // Auth operations
  AUTH_USERINFO_READ: 'auth.userinfo.read',

  // User operations
  USER_CREATE: 'user.create',
  USER_UPDATE: 'user.update',
  USER_DELETE: 'user.delete',

  // Actions operations
  ACTIONS_QUERY: 'actions.query',
  ACTIONS_VOTING: 'actions.voting',
  ACTIONS_VOTING_BATCH: 'actions.voting.batch',
  ACTIONS_VOTE: 'actions.vote',
  ACTIONS_CANCEL: 'actions.cancel',

  // Things operations
  THING_COMMENT_WRITE: 'thing.comment.write',

  WORK_ORDER_CREATE: 'work_order.create',
  WORK_ORDER_READ: 'work_order.read',
  WORK_ORDER_UPDATE: 'work_order.update',
  WORK_ORDER_CLOSE: 'work_order.close',
  WORK_ORDER_CANCEL: 'work_order.cancel',
  WORK_ORDER_ASSIGN: 'work_order.assign',
  WORK_ORDER_REOPEN: 'work_order.reopen'
}

const DEFAULTS = {
  USER_ID: 'anonymous',
  OPERATION_COUNT: 1
}

const STATUS_CODES = {
  OK: 200,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INTERNAL_SERVER_ERROR: 500
}

const LIST_THINGS = 'listThings'
const GET_HISTORICAL_LOGS = 'getHistoricalLogs'

const RPC_METHODS = {
  TAIL_LOG_RANGE_AGGR: 'tailLogCustomRangeAggr',
  GET_WRK_EXT_DATA: 'getWrkExtData',
  SET_WRK_EXT_DATA: 'setWrkExtData',
  LIST_THINGS: 'listThings',
  GET_HISTORICAL_LOGS: 'getHistoricalLogs',
  TAIL_LOG: 'tailLog',
  TAIL_LOG_MULTI: 'tailLogMulti',
  GLOBAL_CONFIG: 'getGlobalConfig',
  GET_CONFIGS: 'getConfigs'
}

const WORKER_TYPES = {
  MINER: 'miner',
  CONTAINER: 'container',
  CABINET: 'cabinet',
  POWERMETER: 'powermeter',
  MINERPOOL: 'minerpool',
  MEMPOOL: 'mempool',
  ELECTRICITY: 'electricity',
  INVENTORY: 'inventory',
  // The Siemens DCS worker registers its thing type as 'dcs-siemens'
  // (WrkDCSBase 'dcs' + '-siemens'); the stat log is tailed by this type.
  DCS: 'dcs-siemens'
}

// Spare parts are inventory things tagged t-inventory-miner_part-<type>
const SPARE_PART_TYPES = ['controller', 'hashboard', 'psu']
const sparePartTag = (type) => `t-inventory-miner_part-${type}`

// BE-10 — historical cooling metric fields produced by the DCS worker stat spec
// (miningos-wrk-dcs-siemens/workers/lib/stats.js -> libStats.specs.dcs.ops). Each
// is a per-interval average; chiller_running is averaged over [0,1] -> uptime ratio.
const COOLING_METRICS_AGGR_FIELDS = {
  miner_supply_temp_c: 1,
  miner_return_temp_c: 1,
  miner_flow_m3h: 1,
  system_pressure_bar: 1,
  hvac_supply_temp_c: 1,
  hvac_return_temp_c: 1,
  chiller_running: 1,
  towers_running: 1,
  pumps_running: 1
}

const SEVERITY_LEVELS = new Set(['critical', 'high', 'medium', 'low'])

// Rank for severity-aware sorting; higher = more severe, unknown severities rank lowest.
const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 }

const ALERTS_DEFAULT_LIMIT = 100
const ALERTS_MAX_SITE_LIMIT = 200
const ALERTS_MAX_HISTORY_LIMIT = 1000

// `message` carries the per-alert device/equipment tag (e.g. 'FIT-7513'), so it
// is filterable and searchable on both endpoints.
const SITE_ALERTS_FILTER_FIELDS = ['severity', 'type', 'container', 'deviceId', 'message']
const SITE_ALERTS_SEARCH_FIELDS = ['id', 'code', 'container', 'message', 'description', 'name']

const HISTORY_FILTER_FIELDS = ['severity', 'code', 'type', 'container', 'deviceId', 'tags', 'message']
const HISTORY_SEARCH_FIELDS = ['name', 'description', 'position', 'code', 'message']

// Operators allowed inside a filter value; anything else is rejected.
const ALERTS_FILTER_OPERATORS = ['$eq', '$ne', '$in', '$nin', '$gt', '$gte', '$lt', '$lte']

const ALERT_TYPE_CATEGORIES = ['all', 'operational', 'miner']

const ALERT_EXT_DATA_WORKER_TYPES = [WORKER_TYPES.MINERPOOL]

// Matches the miner base type and its subtypes (e.g. 'miner-am-s19xp'), not 'minerals'.
const MINER_TYPE_REGEX = '^miner(-|$)'

// Maps history-alert filter fields to the transformed-entry path used by the
// worker's `getHistoricalLogs` query (thing metadata is nested under `thing`).
const HISTORY_ALERTS_QUERY_MAP = {
  severity: 'severity',
  message: 'message',
  code: 'thing.code',
  type: 'thing.type',
  container: 'thing.info.container',
  deviceId: 'thing.id',
  tags: 'thing.tags'
}

const POOL_ALERT_TYPES = [
  'all_pools_dead',
  'wrong_miner_pool',
  'wrong_miner_subaccount',
  'wrong_worker_name',
  'ip_worker_name'
]

const MINER_POOL_STATUS = {
  ONLINE: 'online',
  OFFLINE: 'offline',
  INACTIVE: 'inactive'
}

const METRICS_TIME = {
  ONE_DAY_MS: 24 * 60 * 60 * 1000,
  TWO_DAYS_MS: 2 * 24 * 60 * 60 * 1000,
  SEVEN_DAYS_MS: 7 * 24 * 60 * 60 * 1000,
  NINETY_DAYS_MS: 90 * 24 * 60 * 60 * 1000,
  THREE_HOURS_MS: 3 * 60 * 60 * 1000,
  ONE_MONTH_MS: 30 * 24 * 60 * 60 * 1000
}

const METRICS_DEFAULTS = {
  CONTAINER_HISTORY_LIMIT: 10080,
  POWER_MODE_TIMELINE_WINDOW_SAMPLES: 720
}

const MINER_CATEGORIES = {
  LOW: 'low',
  NORMAL: 'normal',
  HIGH: 'high',
  SLEEP: 'sleep',
  OFFLINE: 'offline',
  ERROR: 'error',
  NOT_MINING: 'notMining',
  MAINTENANCE: 'maintenance'
}

const LOG_KEYS = {
  STAT_RTD: 'stat-rtd',
  STAT_20S: 'stat-20s',
  STAT_1M: 'stat-1m',
  STAT_3H: 'stat-3h',
  STAT_5M: 'stat-5m',
  STAT_30M: 'stat-30m',
  STAT_1D: 'stat-1D'
}

const WORKER_TAGS = {
  MINER: 't-miner',
  CONTAINER: 't-container',
  POWERMETER: 't-powermeter',
  SENSOR: 't-sensor',
  TEMP_SENSOR: 't-sensor-temp'
}

const DEVICE_LIST_FIELDS = {
  id: 1, type: 1, code: 1, ip: 1, tags: 1, info: 1, rack: 1
}

const CONTAINER_LIST_FIELDS = {
  ...DEVICE_LIST_FIELDS,
  comments: 1,
  containerId: 1,
  'opts.address': 1,
  'last.err': 1,
  'last.alerts': 1,
  'last.snap.stats.status': 1,
  'last.snap.stats.power_w': 1,
  'last.snap.stats.ambient_temp_c': 1,
  'last.snap.stats.humidity_percent': 1,
  'last.snap.stats.alarm_status': 1,
  'last.snap.stats.temperature_c': 1,
  'last.snap.stats.uptime_ms': 1
}

const CABINET_DEVICE_FIELDS = {
  id: 1,
  type: 1,
  code: 1,
  tags: 1,
  rack: 1,
  info: 1,
  comments: 1,
  'last.alerts': 1,
  'last.snap.stats': 1
}

// Cooling system field projections by type/view
const COOLING_SYSTEM_PROJECTIONS = {
  base: { id: 1, code: 1, type: 1, tags: 1, rack: 1 },
  equipment: {
    pumps: { 'last.snap.stats.dcs_specific.equipment.pumps': 1 },
    temperatures: { 'last.snap.stats.dcs_specific.equipment.temperatures': 1 },
    pressures: { 'last.snap.stats.dcs_specific.equipment.pressures': 1 },
    flows: { 'last.snap.stats.dcs_specific.equipment.flows': 1 },
    levels: { 'last.snap.stats.dcs_specific.equipment.levels': 1 },
    valves: { 'last.snap.stats.dcs_specific.equipment.valves': 1 },
    heat_exchangers: { 'last.snap.stats.dcs_specific.equipment.heat_exchangers': 1 },
    cooling_towers: { 'last.snap.stats.dcs_specific.equipment.cooling_towers': 1 },
    tanks: { 'last.snap.stats.dcs_specific.equipment.tanks': 1 },
    chillers: { 'last.snap.stats.dcs_specific.equipment.chillers': 1 },
    fan_coils: { 'last.snap.stats.dcs_specific.equipment.fan_coils': 1 },
    humidity_sensors: { 'last.snap.stats.dcs_specific.equipment.humidity_sensors': 1 },
    vibration_sensors: { 'last.snap.stats.dcs_specific.equipment.vibration_sensors': 1 },
    flow_switches: { 'last.snap.stats.dcs_specific.equipment.flow_switches': 1 }
  },
  config: { 'last.snap.config': 1 },
  stats: {
    flow: { 'last.snap.stats.flow': 1 },
    temperature: { 'last.snap.stats.temperature': 1 },
    humidity: { 'last.snap.stats.humidity': 1 }
  },
  miners: {
    circuit1: {
      'last.snap.stats.dcs_specific.equipment.pumps': 1,
      'last.snap.stats.dcs_specific.equipment.temperatures': 1,
      'last.snap.stats.dcs_specific.equipment.pressures': 1,
      'last.snap.stats.dcs_specific.equipment.flows': 1,
      'last.snap.stats.dcs_specific.equipment.levels': 1,
      'last.snap.stats.dcs_specific.equipment.heat_exchangers': 1,
      'last.snap.stats.dcs_specific.equipment.valves': 1,
      'last.snap.stats.dcs_specific.equipment.tanks': 1,
      'last.snap.config.cooling_system': 1
    },
    circuit2: {
      'last.snap.stats.dcs_specific.equipment.pumps': 1,
      'last.snap.stats.dcs_specific.equipment.temperatures': 1,
      'last.snap.stats.dcs_specific.equipment.levels': 1,
      'last.snap.stats.dcs_specific.equipment.heat_exchangers': 1,
      'last.snap.stats.dcs_specific.equipment.cooling_towers': 1,
      'last.snap.stats.dcs_specific.equipment.valves': 1,
      'last.snap.stats.dcs_specific.equipment.tanks': 1,
      'last.snap.stats.dcs_specific.equipment.vibration_sensors': 1,
      'last.snap.stats.dcs_specific.equipment.vibration_switches': 1,
      'last.snap.stats.dcs_specific.equipment.fans': 1,
      'last.snap.config.cooling_system': 1
    },
    layout: {
      'last.snap.stats.dcs_specific.equipment.pumps': 1,
      'last.snap.stats.dcs_specific.equipment.temperatures': 1,
      'last.snap.stats.dcs_specific.equipment.pressures': 1,
      'last.snap.stats.dcs_specific.equipment.flows': 1,
      'last.snap.stats.dcs_specific.equipment.levels': 1,
      'last.snap.stats.dcs_specific.equipment.heat_exchangers': 1,
      'last.snap.stats.dcs_specific.equipment.cooling_towers': 1,
      'last.snap.stats.dcs_specific.equipment.valves': 1,
      'last.snap.stats.dcs_specific.equipment.tanks': 1,
      'last.snap.stats.dcs_specific.equipment.vibration_sensors': 1,
      'last.snap.stats.dcs_specific.equipment.vibration_switches': 1,
      'last.snap.stats.dcs_specific.equipment.fans': 1,
      'last.snap.stats.flow': 1,
      'last.snap.config.cooling_system': 1,
      'last.snap.config.mining': 1
    }
  },
  hvac: {
    circuit1: {
      'last.snap.stats.dcs_specific.equipment.pumps': 1,
      'last.snap.stats.dcs_specific.equipment.temperatures': 1,
      'last.snap.stats.dcs_specific.equipment.pressures': 1,
      'last.snap.stats.dcs_specific.equipment.flows': 1,
      'last.snap.stats.dcs_specific.equipment.levels': 1,
      'last.snap.stats.dcs_specific.equipment.chillers': 1,
      'last.snap.stats.dcs_specific.equipment.fan_coils': 1,
      'last.snap.stats.dcs_specific.equipment.fans': 1,
      'last.snap.stats.dcs_specific.equipment.valves': 1,
      'last.snap.stats.dcs_specific.equipment.tanks': 1,
      'last.snap.stats.dcs_specific.equipment.flow_switches': 1,
      'last.snap.config.cooling_system': 1
    },
    circuit2: {
      'last.snap.stats.dcs_specific.equipment.pumps': 1,
      'last.snap.stats.dcs_specific.equipment.temperatures': 1,
      'last.snap.stats.dcs_specific.equipment.flows': 1,
      'last.snap.stats.dcs_specific.equipment.levels': 1,
      'last.snap.stats.dcs_specific.equipment.cooling_towers': 1,
      'last.snap.stats.dcs_specific.equipment.vibration_sensors': 1,
      'last.snap.stats.dcs_specific.equipment.vibration_switches': 1,
      'last.snap.config.cooling_system': 1
    },
    layout: {
      'last.snap.stats.dcs_specific.equipment.pumps': 1,
      'last.snap.stats.dcs_specific.equipment.temperatures': 1,
      'last.snap.stats.dcs_specific.equipment.pressures': 1,
      'last.snap.stats.dcs_specific.equipment.flows': 1,
      'last.snap.stats.dcs_specific.equipment.levels': 1,
      'last.snap.stats.dcs_specific.equipment.chillers': 1,
      'last.snap.stats.dcs_specific.equipment.cooling_towers': 1,
      'last.snap.stats.dcs_specific.equipment.fan_coils': 1,
      'last.snap.stats.dcs_specific.equipment.fans': 1,
      'last.snap.stats.dcs_specific.equipment.valves': 1,
      'last.snap.stats.dcs_specific.equipment.tanks': 1,
      'last.snap.stats.dcs_specific.equipment.flow_switches': 1,
      'last.snap.stats.dcs_specific.equipment.vibration_sensors': 1,
      'last.snap.stats.dcs_specific.equipment.vibration_switches': 1,
      'last.snap.config.cooling_system': 1
    },
    ambient: {
      'last.snap.stats.dcs_specific.equipment.fan_coils': 1,
      'last.snap.stats.dcs_specific.equipment.humidity_sensors': 1,
      'last.snap.stats.humidity': 1,
      'last.snap.config.cooling_system': 1
    }
  }
}

const ENERGY_SYSTEM_PROJECTIONS = {
  base: { id: 1, code: 1, type: 1, tags: 1, rack: 1 },
  miners: {
    'last.snap.stats.dcs_specific.equipment.power_meters': 1,
    'last.snap.stats.energy': 1,
    'last.snap.config.energy_layout': 1
  },
  cooling_auxiliary: {
    'last.snap.stats.dcs_specific.equipment.power_meters': 1,
    'last.snap.stats.energy': 1,
    'last.snap.config.energy_layout': 1
  },
  layout: {
    'last.snap.stats.dcs_specific.equipment.power_meters': 1,
    'last.snap.stats.dcs_specific.equipment.protection_relays': 1,
    'last.snap.stats.dcs_specific.equipment.transformers': 1,
    'last.snap.stats.dcs_specific.equipment.distribution_boards': 1,
    'last.snap.stats.energy': 1,
    'last.snap.config.energy_layout': 1
  }
}

// Site Overview aggregation fields for group-level stats
const SITE_OVERVIEW_AGGR_FIELDS = {
  hashrate_mhs_5m_container_group_sum_aggr: 1,
  hashrate_mhs_5m_rack_group_sum_aggr: 1,
  power_w_container_group_sum_aggr: 1,
  power_w_rack_group_sum_aggr: 1,
  efficiency_w_ths_container_group_avg_aggr: 1,
  efficiency_w_ths_pdu_rack_group_avg_aggr: 1,
  hashrate_mhs_5m_pdu_rack_group_sum_aggr: 1,
  power_w_pdu_rack_group_sum_aggr: 1,
  offline_cnt: 1,
  error_cnt: 1,
  not_mining_cnt: 1,
  power_mode_sleep_cnt: 1,
  power_mode_low_cnt: 1,
  power_mode_normal_cnt: 1,
  power_mode_high_cnt: 1,
  hashrate_mhs_5m_active_container_group_cnt: 1
}

const SITE_STATUS_LIVE_AGGR_FIELDS = {
  hashrate_mhs_1m_sum_aggr: 1,
  nominal_hashrate_mhs_sum_aggr: 1,
  alerts_aggr: 1,
  online_or_minor_error_miners_amount_aggr: 1,
  not_mining_miners_amount_aggr: 1,
  offline_or_sleeping_miners_amount_aggr: 1,
  hashrate_mhs_1m_cnt_aggr: 1,
  container_nominal_miner_capacity_sum_aggr: 1
}

// Ignore tail-log entries older than this (header UI uses start = now - 10min)
const SITE_STATUS_LIVE_WINDOW_MS = 10 * 60 * 1000

// DCS power meter field projections for site overview
const DCS_POWER_METER_FIELDS = {
  'last.snap.stats.dcs_specific.equipment.power_meters': 1,
  'last.snap.config.mining': 1,
  'last.snap.config.energy_layout': 1
}

const DCS_MINER_COOLING_STATUS_FIELDS = {
  'last.snap.stats.dcs_specific.cooling_system': 1
}

// DCS field projections for site efficiency
const DCS_EFFICIENCY_FIELDS = {
  'last.snap.stats.dcs_specific.equipment.power_meters': 1,
  'last.snap.stats.dcs_specific.equipment.distribution_boards': 1,
  'last.snap.stats.dcs_specific.equipment.transformers': 1,
  'last.snap.config.mining': 1,
  'last.snap.config.energy_layout': 1
}

const LOG_FIELDS = {
  HASHRATE_SUM: 'hashrate_mhs_5m_sum',
  NOMINAL_HASHRATE_SUM: 'nominal_hashrate_mhs_sum',
  SITE_POWER: 'site_power_w',
  BY_METER_POWER: 'by_meter_power_w',
  EFFICIENCY: 'efficiency_w_ths_avg',
  HASHRATE_SUM_TYPE_GROUP: 'hashrate_mhs_5m_type_group_sum',
  HASHRATE_SUM_CONTAINER_GROUP: 'hashrate_mhs_5m_container_group_sum',
  HASHRATE_SUM_RACK_GROUP: 'hashrate_mhs_5m_pdu_rack_group_sum',
  POWER_W_TYPE_GROUP_SUM: 'power_w_type_group_sum',
  POWER_W_CONTAINER_GROUP_SUM: 'power_w_container_group_sum',
  POWER_W_RACK_GROUP_SUM: 'power_w_pdu_rack_group_sum',
  EFFICIENCY_TYPE_GROUP_AVG: 'efficiency_w_ths_type_group_avg',
  EFFICIENCY_CONTAINER_GROUP_AVG: 'efficiency_w_ths_container_group_avg',
  EFFICIENCY_RACK_GROUP_AVG: 'efficiency_w_ths_pdu_rack_group_avg'
}

const AGGR_FIELDS = {
  HASHRATE_SUM: 'hashrate_mhs_5m_sum_aggr',
  NOMINAL_HASHRATE_SUM: 'nominal_hashrate_mhs_sum_aggr',
  HASHRATE_SUM_TYPE_GROUP_AGGR: 'hashrate_mhs_5m_type_group_sum_aggr',
  HASHRATE_SUM_CONTAINER_GROUP_AGGR: 'hashrate_mhs_5m_container_group_sum_aggr',
  HASHRATE_SUM_RACK_GROUP_AGGR: 'hashrate_mhs_5m_pdu_rack_group_sum_aggr',
  SITE_POWER: 'site_power_w',
  BY_METER_POWER: 'by_meter_power_w',
  ENERGY_AGGR: 'energy_aggr',
  ACTIVE_ENERGY_IN: 'active_energy_in_aggr',
  UTE_ENERGY: 'ute_energy_aggr',
  EFFICIENCY: 'efficiency_w_ths_avg_aggr',
  EFFICIENCY_TYPE_GROUP_AVG: 'efficiency_w_ths_type_group_avg_aggr',
  EFFICIENCY_CONTAINER_GROUP_AVG: 'efficiency_w_ths_container_group_avg_aggr',
  EFFICIENCY_RACK_GROUP_AVG: 'efficiency_w_ths_pdu_rack_group_avg_aggr',
  POWER_MODE_GROUP: 'power_mode_group_aggr',
  STATUS_GROUP: 'status_group_aggr',
  TEMP_MAX: 'temperature_c_group_max_aggr',
  TEMP_AVG: 'temperature_c_group_avg_aggr',
  TYPE_CNT: 'type_cnt',
  OFFLINE_CNT: 'offline_cnt',
  SLEEP_CNT: 'power_mode_sleep_cnt',
  MAINTENANCE_CNT: 'maintenance_type_cnt',
  OFFLINE_TYPE_CNT: 'offline_type_cnt',
  SLEEP_TYPE_CNT: 'power_mode_sleep_type_cnt',
  ERROR_TYPE_CNT: 'error_type_cnt',
  CONTAINER_SPECIFIC_STATS: 'container_specific_stats_group_aggr',
  HASHRATE_1M_CONTAINER_GROUP_SUM: 'hashrate_mhs_1m_container_group_sum_aggr',
  POWER_W_CONTAINER_GROUP_SUM: 'power_w_container_group_sum_aggr',
  POWER_W_TYPE_GROUP_SUM: 'power_w_type_group_sum_aggr',
  POWER_W_RACK_GROUP_SUM: 'power_w_pdu_rack_group_sum_aggr',
  POWER_MODE_LOW_CNT: 'power_mode_low_cnt',
  POWER_MODE_NORMAL_CNT: 'power_mode_normal_cnt',
  POWER_MODE_HIGH_CNT: 'power_mode_high_cnt',
  POWER_MODE_LOW_TYPE_CNT: 'power_mode_low_type_cnt',
  POWER_MODE_NORMAL_TYPE_CNT: 'power_mode_normal_type_cnt',
  POWER_MODE_HIGH_TYPE_CNT: 'power_mode_high_type_cnt',
  ERROR_CNT: 'error_cnt',
  NOT_MINING_CNT: 'not_mining_cnt',
  ACTIVE_CONTAINER_CNT: 'hashrate_mhs_5m_active_container_group_cnt',
  MINER_INVENTORY_STATUS: 'miner_inventory_status_group_cnt_aggr',
  MINER_INVENTORY_LOCATION: 'miner_inventory_location_group_cnt_aggr',
  SPARE_PARTS_CNT: 'spare_parts_cnt_aggr',
  SPARE_PART_INVENTORY_STATUS: 'spare_part_inventory_status_group_cnt_aggr',
  SPARE_PART_INVENTORY_LOCATION: 'spare_part_inventory_location_group_cnt_aggr'
}

const PERIOD_TYPES = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  YEARLY: 'yearly'
}

const MINERPOOL_EXT_DATA_KEYS = {
  TRANSACTIONS: 'transactions',
  STATS: 'stats'
}

const ELECTRICITY_EXT_DATA_KEYS = {
  FORECAST: 'forecast',
  FORECAST_SETTINGS: 'forecastSettings',
  FORECAST_HISTORY: 'forecastHistory',
  AVAIL_ENERGY: 'availableEnergy',
  FORECAST_OVERRIDE: 'forecastOverride'
}

const NON_METRIC_KEYS = [
  'ts',
  'site',
  'year',
  'monthName',
  'month',
  'period'
]

const BTC_SATS = 100000000

const RANGE_BUCKETS = {
  '1D': 86400000,
  '1W': 604800000,
  '1M': 2592000000
}

const RPC_TIMEOUT = 15000
const RPC_CONCURRENCY_LIMIT = 2
const RPC_PAGE_LIMIT = 100

// A pooled protomux-rpc channel can be torn down between requests, so the first
// jRequest that reuses it fails while an immediate re-dial succeeds. Retry those.
const RPC_RETRYABLE_ERRORS = ['CHANNEL_CLOSED', 'channel closed']
const RPC_MAX_ATTEMPTS = 3
const RPC_RETRY_DELAY = 100

// Only read methods may be retried. A channel can drop after the ork applied the
// request but before the response arrives — indistinguishable from a drop before
// it was applied — so retrying a write can execute it twice, and no write payload
// carries an idempotency key (pushActionsBatch has a client-supplied
// batchActionUID, but the single-action path has nothing). This is an allowlist,
// not a denylist, so a method reaching the proxy dynamically or a write added
// later defaults to not retrying.
const RPC_RETRYABLE_METHODS = new Set([
  'getAction',
  'getActionsBatch',
  'getConfigs',
  'getGlobalConfig',
  'getHistoricalLogs',
  'getThingConf',
  'getThingsCount',
  'getWrkConf',
  'getWrkExtData',
  'getWrkSettings',
  'listFirmwares',
  'listRacks',
  'listThings',
  'loadFile',
  'queryActions',
  'tailLog',
  'tailLogCustomRangeAggr',
  'tailLogMulti'
])

// Upper bound on rows a request that sends no limit may span, rejecting the
// unbounded ranges that pull hundreds of thousands of rows over one RPC channel.
// Sized off the only limitless caller, the UI's historical miner KPI export: it
// picks the finest stat key whose bucket count fits its own 8640-row budget, so
// 8640 is the largest range it ever asks for (30 days of stat-5m, or 6 days of
// stat-1m on a 1-minute site).
const TAIL_LOG_MAX_ROWS = 9000

// Upper bound on a client-supplied limit, which bounds the response on its own
// and so exempts the request from the range check above. Sized off the UI's
// widest limit, the dashboard power-mode timeline's 7 days of stat-1m.
const TAIL_LOG_MAX_LIMIT = 10080

// Bucket width per stat key, used to estimate the row count of a range. Covers
// every fixed-width key in LOG_KEYS: a key missing here would make the range
// guard fail open, which is how an unbounded year of stat-20s (~1.58M buckets)
// could slip past it.
const TAIL_LOG_BUCKET_MS = {
  'stat-20s': 20 * 1000,
  'stat-1m': 60 * 1000,
  'stat-5m': 5 * 60 * 1000,
  'stat-30m': 30 * 60 * 1000,
  'stat-3h': 3 * 60 * 60 * 1000,
  'stat-1D': 24 * 60 * 60 * 1000
}

// The one stat key with no fixed bucket width: stat-rtd holds the latest sample
// per thing, not a time series, so its row count is bounded by the thing count
// rather than by the range. Deliberately exempt from the range guard; every other
// stat-* key without a bucket width above is rejected rather than waved through.
const TAIL_LOG_UNBUCKETED_KEYS = new Set(['stat-rtd'])

const AUTH_CACHE_TTL = 60 * 1000

const ACTIONS_MAX_QUERIES = 10
const ACTIONS_QUERIES_MAX_LENGTH = 1000

// Allowed config types for generic config CRUD
const CONFIG_TYPES = {
  POOL: 'pool'
}

const MINER_FIELD_MAP = {
  status: 'last.snap.stats.status',
  hashrate: 'last.snap.stats.hashrate_mhs',
  power: 'last.snap.stats.power_w',
  efficiency: 'last.snap.stats.efficiency_w_ths',
  temperature: 'last.snap.stats.temperature_c',
  powerMode: 'last.snap.config.power_mode',
  firmware: 'last.snap.config.firmware_ver',
  model: 'last.snap.model',
  ip: 'address',
  subnet: 'info.subnet',
  container: 'info.container',
  rack: 'rack',
  serialNum: 'info.serialNum',
  macAddress: 'info.macAddress',
  pool: 'last.snap.config.pool_config.url',
  led: 'last.snap.config.led_status',
  alerts: 'last.alerts',
  // `poolConfig` in a response is the miner-reported endpoint list
  // (`last.snap.config.pool_config`); the assigned pool config lives on
  // `info.poolConfig` and is exposed as `poolConfigId`.
  poolConfig: 'info.poolConfig',
  poolConfigId: 'info.poolConfig'
}

const MINER_PROJECTION_MAP = {
  id: ['id'],
  type: ['type'],
  model: ['last.snap.model', 'type'],
  code: ['code'],
  ip: ['address', 'last.snap.config.network_config.ip_address'],
  subnet: ['info.subnet'],
  container: ['info.container'],
  rack: ['rack'],
  position: ['info.pos'],
  status: ['last.snap.stats.status'],
  hashrate: ['last.snap.stats.hashrate_mhs'],
  power: ['last.snap.stats.power_w'],
  temperature: ['last.snap.stats.temperature_c'],
  frequency: ['last.snap.stats.frequency_mhz'],
  efficiency: ['last.snap.stats.efficiency_w_ths'],
  uptime: ['last.snap.stats.uptime_ms'],
  firmware: ['last.snap.config.firmware_ver'],
  powerMode: ['last.snap.config.power_mode'],
  ledStatus: ['last.snap.config.led_status'],
  poolConfig: ['last.snap.config.pool_config'],
  poolConfigId: ['info.poolConfig'],
  alerts: ['last.alerts'],
  comments: ['comments'],
  serialNum: ['info.serialNum'],
  macAddress: ['info.macAddress'],
  lastSeen: ['last.ts', 'ts']
}

const MINER_SEARCH_FIELDS = [
  'id',
  'address',
  'info.serialNum',
  'info.macAddress',
  'info.container',
  'code',
  'type'
]

const MINER_DEFAULT_FIELDS = {
  id: 1,
  type: 1,
  code: 1,
  info: 1,
  tags: 1,
  rack: 1,
  comments: 1,
  'last.alerts': 1,
  'last.snap.stats': 1,
  'last.snap.config': 1,
  'last.snap.model': 1,
  'last.ts': 1,
  address: 1,
  ts: 1
}

const MINER_MAX_LIMIT = 200
const MINER_DEFAULT_LIMIT = 50

// Raw-doc projection for the container-scoped miners list. Matches the
// fields the container view reads so the response stays lean.
const CONTAINER_MINER_FIELDS = {
  id: 1,
  type: 1,
  code: 1,
  info: 1,
  tags: 1,
  rack: 1,
  address: 1,
  'opts.address': 1,
  'last.alerts': 1,
  'last.snap.stats.status': 1,
  'last.snap.stats.are_all_errors_minor': 1,
  'last.snap.stats.hashrate': 1,
  'last.snap.stats.hashrate_mhs': 1,
  'last.snap.stats.temperature_c': 1,
  'last.snap.stats.frequency_mhz': 1,
  'last.snap.stats.power_w': 1,
  'last.snap.stats.miner_specific.power_pct': 1,
  'last.snap.stats.uptime_ms': 1,
  'last.snap.config.power_mode': 1,
  'last.snap.config.led_status': 1,
  'last.snap.config.firmware_ver': 1,
  'last.snap.config.pool_config': 1
}

// Explorer racks aggregation fields
const EXPLORER_RACK_AGGR_FIELDS = {
  hashrate_mhs_5m_pdu_rack_group_sum_aggr: 1,
  power_w_pdu_rack_group_sum_aggr: 1,
  efficiency_w_ths_pdu_rack_group_avg_aggr: 1
}

const EXPLORER_RACK_DEFAULT_LIMIT = 20
const EXPLORER_RACK_MAX_LIMIT = 100
const MICROSOFT_AUTH_SCOPE = ['openid', 'profile', 'email', 'User.Read']

module.exports = {
  SUPER_ADMIN_ROLE,
  GLOBAL_DATA_TYPES,
  LCOE_SOURCES,
  SUPER_ADMIN_ID,
  MIGRATED_USER_ROLES,
  COMMENT_ACTION,
  AUTH_PERMISSIONS,
  AUTH_LEVELS,
  AUTH_CAPS,
  ENDPOINTS,
  HTTP_METHODS,
  OPERATIONS,
  DEFAULTS,
  STATUS_CODES,
  RPC_TIMEOUT,
  RPC_CONCURRENCY_LIMIT,
  RPC_PAGE_LIMIT,
  RPC_RETRYABLE_ERRORS,
  RPC_MAX_ATTEMPTS,
  RPC_RETRY_DELAY,
  RPC_RETRYABLE_METHODS,
  TAIL_LOG_MAX_ROWS,
  TAIL_LOG_MAX_LIMIT,
  TAIL_LOG_BUCKET_MS,
  TAIL_LOG_UNBUCKETED_KEYS,
  AUTH_CACHE_TTL,
  ACTIONS_MAX_QUERIES,
  ACTIONS_QUERIES_MAX_LENGTH,
  USER_SETTINGS_TYPE,
  LIST_THINGS,
  GET_HISTORICAL_LOGS,
  RPC_METHODS,
  WORKER_TYPES,
  SPARE_PART_TYPES,
  sparePartTag,
  POOL_ALERT_TYPES,
  MINER_POOL_STATUS,
  AGGR_FIELDS,
  PERIOD_TYPES,
  MINERPOOL_EXT_DATA_KEYS,
  NON_METRIC_KEYS,
  BTC_SATS,
  RANGE_BUCKETS,
  CONFIG_TYPES,
  METRICS_TIME,
  METRICS_DEFAULTS,
  MINER_CATEGORIES,
  LOG_KEYS,
  WORKER_TAGS,
  SEVERITY_LEVELS,
  SEVERITY_RANK,
  ALERTS_DEFAULT_LIMIT,
  ALERTS_MAX_SITE_LIMIT,
  ALERTS_MAX_HISTORY_LIMIT,
  SITE_ALERTS_FILTER_FIELDS,
  SITE_ALERTS_SEARCH_FIELDS,
  HISTORY_FILTER_FIELDS,
  HISTORY_SEARCH_FIELDS,
  ALERTS_FILTER_OPERATORS,
  ALERT_TYPE_CATEGORIES,
  ALERT_EXT_DATA_WORKER_TYPES,
  MINER_TYPE_REGEX,
  HISTORY_ALERTS_QUERY_MAP,
  DEVICE_LIST_FIELDS,
  CONTAINER_LIST_FIELDS,
  CABINET_DEVICE_FIELDS,
  MINER_FIELD_MAP,
  MINER_PROJECTION_MAP,
  MINER_SEARCH_FIELDS,
  MINER_DEFAULT_FIELDS,
  MINER_MAX_LIMIT,
  MINER_DEFAULT_LIMIT,
  CONTAINER_MINER_FIELDS,
  COOLING_SYSTEM_PROJECTIONS,
  ENERGY_SYSTEM_PROJECTIONS,
  SITE_OVERVIEW_AGGR_FIELDS,
  SITE_STATUS_LIVE_AGGR_FIELDS,
  SITE_STATUS_LIVE_WINDOW_MS,
  DCS_POWER_METER_FIELDS,
  DCS_MINER_COOLING_STATUS_FIELDS,
  DCS_EFFICIENCY_FIELDS,
  EXPLORER_RACK_AGGR_FIELDS,
  EXPLORER_RACK_DEFAULT_LIMIT,
  EXPLORER_RACK_MAX_LIMIT,
  COOLING_METRICS_AGGR_FIELDS,
  LOG_FIELDS,
  ELECTRICITY_EXT_DATA_KEYS,
  WORK_ORDER_THING_TYPE,
  WORK_ORDER_TYPES,
  WORK_ORDER_TERMINAL_STATUSES,
  WORK_ORDER_VALID_DEVICE_TYPES,
  MINER_LOCATIONS,
  MINER_ROOM_LOCATION,
  MAINTENANCE_CONTAINER,
  SPARE_PART_INITIAL_LOCATION,
  FILE_TYPES,
  WORK_ORDER_ACTION_WAIT_ATTEMPTS,
  WORK_ORDER_ACTION_WAIT_MS,
  WORK_ORDER_FILE_MAX_BYTES_DEFAULT,
  WORK_ORDER_FILE_COUNT_CAP_DEFAULT,
  WORK_ORDER_FILE_MIME_ALLOWLIST_DEFAULT,
  WORK_ORDER_EXPORT_FORMATS,
  RMA_COLUMNS,
  MINER_MODEL_DISPLAY_NAMES,
  MICROSOFT_AUTH_SCOPE
}
