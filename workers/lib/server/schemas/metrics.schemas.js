'use strict'

const { POOL_HASHRATE_INTERVALS_MS } = require('../../constants')

// 1M is a 30-day month. Distinct from 1m (one minute) used by
// powerModeTimeline / containerHistory.
const METRICS_INTERVALS = ['1h', '1d', '1w', '1M']

const schemas = {
  query: {
    hashrate: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        interval: { type: 'string', enum: METRICS_INTERVALS },
        // Only read by the '1M' rollup, which cuts months in this zone rather than UTC.
        timezone: { type: 'string' },
        groupBy: { type: 'string', enum: ['miner', 'container', 'rack'] },
        phase: { type: 'string', maxLength: 64 },
        container: { type: 'string' },
        current: { type: 'boolean' },
        nominal: { type: 'boolean' },
        pool: { type: 'boolean' },
        racks: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1 },
        reverse: { type: 'boolean' },
        overwriteCache: { type: 'boolean' }
      },
      required: ['start', 'end']
    },
    consumption: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        interval: { type: 'string', enum: METRICS_INTERVALS },
        groupBy: { type: 'string', enum: ['miner', 'container', 'rack'] },
        byMeter: { type: 'boolean' },
        racks: { type: 'string' },
        overwriteCache: { type: 'boolean' }
      },
      required: ['start', 'end']
    },
    efficiency: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        interval: { type: 'string', enum: METRICS_INTERVALS },
        groupBy: { type: 'string', enum: ['miner', 'container', 'rack'] },
        phase: { type: 'string', maxLength: 64 },
        racks: { type: 'string' },
        overwriteCache: { type: 'boolean' }
      },
      required: ['start', 'end']
    },
    minerStatus: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        groupBy: { type: 'string', enum: ['type'] },
        overwriteCache: { type: 'boolean' }
      },
      required: ['start', 'end']
    },
    minersByContainer: {
      type: 'object',
      properties: {
        overwriteCache: { type: 'boolean' }
      }
    },
    siteSummary: {
      type: 'object',
      properties: {
        overwriteCache: { type: 'boolean' }
      }
    },
    inventorySummary: {
      type: 'object',
      properties: {
        overwriteCache: { type: 'boolean' }
      }
    },
    minersByType: {
      type: 'object',
      properties: {
        overwriteCache: { type: 'boolean' }
      }
    },
    inventoryMinerDistribution: {
      type: 'object',
      properties: {
        overwriteCache: { type: 'boolean' }
      }
    },
    revenueHourly: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        pool: { type: 'string' },
        overwriteCache: { type: 'boolean' }
      },
      required: ['start', 'end']
    },
    powerMode: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        interval: { type: 'string', enum: METRICS_INTERVALS },
        overwriteCache: { type: 'boolean' }
      },
      required: ['start', 'end']
    },
    // No start/end: the window is lookbackDays back from now, so the cache key
    // stays a handful of interval:days combinations instead of a fresh entry
    // per request timestamp.
    poolHashrate: {
      type: 'object',
      properties: {
        interval: { type: 'string', enum: Object.keys(POOL_HASHRATE_INTERVALS_MS) },
        lookbackDays: { type: 'integer', minimum: 1, maximum: 90 },
        phase: { type: 'string', maxLength: 64 },
        overwriteCache: { type: 'boolean' }
      },
      required: ['interval', 'lookbackDays']
    },
    powerModeTimeline: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        interval: { type: 'string', enum: ['1m', '5m', '30m', '3h'] },
        container: { type: 'string' },
        overwriteCache: { type: 'boolean' }
      }
    },
    temperature: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        interval: { type: 'string', enum: METRICS_INTERVALS },
        container: { type: 'string' },
        overwriteCache: { type: 'boolean' }
      },
      required: ['start', 'end']
    },
    cooling: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        interval: { type: 'string', enum: [...METRICS_INTERVALS, 'hourly', 'daily', 'weekly'] },
        overwriteCache: { type: 'boolean' }
      },
      required: ['start', 'end']
    },
    downtime: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        interval: { type: 'string', enum: ['1h', '1d'] },
        timezone: { type: 'string', maxLength: 100 },
        overwriteCache: { type: 'boolean' }
      },
      required: ['start', 'end']
    },
    containerTelemetry: {
      type: 'object',
      properties: {
        overwriteCache: { type: 'boolean' }
      }
    },
    containerHistory: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        interval: { type: 'string', enum: ['20s', '1m', '5m', '30m', '3h', '1d'] },
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
        overwriteCache: { type: 'boolean' }
      }
    }
  }
}

module.exports = schemas
