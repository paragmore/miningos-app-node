'use strict'

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
        groupBy: { type: 'string', enum: ['miner', 'container', 'rack'] },
        container: { type: 'string' },
        current: { type: 'boolean' },
        nominal: { type: 'boolean' },
        racks: { type: 'string' },
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
