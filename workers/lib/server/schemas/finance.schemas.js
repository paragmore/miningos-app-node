'use strict'

const schemas = {
  query: {
    energyBalance: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        period: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
        overwriteCache: { type: 'boolean' },
        timezone: { type: 'string', maxLength: 100 }
      },
      required: ['start', 'end']
    },
    ebitda: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        period: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
        overwriteCache: { type: 'boolean' },
        timezone: { type: 'string', maxLength: 100 }
      },
      required: ['start', 'end']
    },
    costSummary: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        period: { type: 'string', enum: ['daily', 'monthly', 'yearly'] },
        overwriteCache: { type: 'boolean' },
        timezone: { type: 'string', maxLength: 100 }
      },
      required: ['start', 'end']
    },
    subsidyFees: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        period: { type: 'string', enum: ['daily', 'weekly', 'monthly'] },
        overwriteCache: { type: 'boolean' },
        timezone: { type: 'string', maxLength: 100 }
      },
      required: ['start', 'end']
    },
    revenue: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        period: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
        pool: { type: 'string' },
        overwriteCache: { type: 'boolean' },
        timezone: { type: 'string', maxLength: 100 }
      },
      required: ['start', 'end']
    },
    revenueSummary: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        period: { type: 'string', enum: ['daily', 'monthly', 'yearly'] },
        phase: { type: 'string', maxLength: 64 },
        overwriteCache: { type: 'boolean' },
        timezone: { type: 'string', maxLength: 100 }
      },
      required: ['start', 'end']
    },
    hashRevenue: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        period: { type: 'string', enum: ['daily', 'monthly', 'yearly'] },
        overwriteCache: { type: 'boolean' },
        timezone: { type: 'string', maxLength: 100 }
      },
      required: ['start', 'end']
    },
    powerCost: {
      type: 'object',
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
        overwriteCache: { type: 'boolean' },
        timezone: { type: 'string', maxLength: 100 }
      },
      required: ['start', 'end']
    }
  }
}

module.exports = schemas
