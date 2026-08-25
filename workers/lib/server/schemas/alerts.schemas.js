'use strict'

const schemas = {
  query: {
    alertsConfig: {
      type: 'object',
      properties: {
        overwriteCache: { type: 'boolean' }
      }
    },
    alertsParams: {
      type: 'object',
      properties: {
        overwriteCache: { type: 'boolean' }
      }
    },
    siteAlerts: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['all', 'operational', 'miner'] },
        filter: { type: 'string' },
        sort: { type: 'string' },
        search: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1 },
        overwriteCache: { type: 'boolean' }
      }
    },
    alertsHistory: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        type: { type: 'string', enum: ['all', 'operational', 'miner'] },
        filter: { type: 'string' },
        search: { type: 'string' },
        sort: { type: 'string' },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1 },
        overwriteCache: { type: 'boolean' }
      },
      required: ['start', 'end']
    }
  },
  body: {
    setAlertParams: {
      type: 'object',
      properties: {
        data: {
          type: 'object'
        }
      },
      required: ['data']
    }
  }
}

module.exports = schemas
