'use strict'

const { ENDPOINTS, HTTP_METHODS } = require('../../constants')
const { getPduLayout } = require('../handlers/pdu.layout.handlers')
const { createCachedAuthRoute } = require('../lib/routeHelpers')

module.exports = (ctx) => [
  {
    method: HTTP_METHODS.GET,
    url: ENDPOINTS.PDU_LAYOUT,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: "Device/container type, e.g. 'container-bd-d40-m30', 'container-as-hk3', or 'group'"
          },
          container: {
            type: 'string',
            description: "Group-site container id (used to substitute the layout's 'X' placeholder)"
          },
          overwriteCache: {
            type: 'boolean'
          }
        },
        required: ['type']
      }
    },
    ...createCachedAuthRoute(
      ctx,
      (req) => ['pdu-layout', req.query.type, req.query.container],
      ENDPOINTS.PDU_LAYOUT,
      getPduLayout
    )
  }
]
