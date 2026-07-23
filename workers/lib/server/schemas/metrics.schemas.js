'use strict'

const schemas = {
  query: {
    hashrate: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        interval: { type: 'string', enum: ['1h', '1d', '1w'] },
        groupBy: { type: 'string', enum: ['miner', 'container', 'rack'] },
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
        interval: { type: 'string', enum: ['1h', '1d', '1w'] },
        groupBy: { type: 'string', enum: ['miner', 'container', 'rack'] },
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
        interval: { type: 'string', enum: ['1h', '1d', '1w'] },
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
    powerMode: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        interval: { type: 'string', enum: ['1h', '1d', '1w'] },
        overwriteCache: { type: 'boolean' }
      },
      required: ['start', 'end']
    },
    powerModeTimeline: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        container: { type: 'string' },
        overwriteCache: { type: 'boolean' }
      }
    },
    temperature: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        interval: { type: 'string', enum: ['1h', '1d', '1w'] },
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
        interval: { type: 'string', enum: ['1h', '1d', '1w', 'hourly', 'daily', 'weekly'] },
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
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
        overwriteCache: { type: 'boolean' }
      }
    }
  }
}

module.exports = schemas
