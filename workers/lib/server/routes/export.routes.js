'use strict'

const { ENDPOINTS, HTTP_METHODS } = require('../../constants')
const { EXPORT_TYPES, EXPORT_FORMATS } = require('../lib/export/registry')
const { exportRoute } = require('../handlers/export.handlers')
const { createAuthOnRequest } = require('../lib/routeHelpers')

module.exports = (ctx) => [
  {
    method: HTTP_METHODS.GET,
    url: ENDPOINTS.EXPORT,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: EXPORT_TYPES },
          format: { type: 'string', enum: EXPORT_FORMATS, default: 'csv' },
          container: { type: 'string', maxLength: 200 },
          statKey: { type: 'string', enum: ['stat-1m', 'stat-5m', 'stat-3h'] },
          start: { type: 'integer', minimum: 0 },
          end: { type: 'integer', minimum: 0 },
          timezone: { type: 'string', maxLength: 100 }
        },
        required: ['type']
      }
    },
    onRequest: createAuthOnRequest(ctx),
    handler: (req, reply) => exportRoute(ctx, req, reply)
  }
]
