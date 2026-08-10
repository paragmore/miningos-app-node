'use strict'

const {
  ENDPOINTS,
  HTTP_METHODS,
  AUTH_CAPS,
  AUTH_LEVELS
} = require('../../constants')
const { listMiners, listContainerMiners, listFirmwares } = require('../handlers/miners.handlers')
const { createCachedAuthRoute } = require('../lib/routeHelpers')

module.exports = (ctx) => [
  {
    method: HTTP_METHODS.GET,
    url: ENDPOINTS.MINERS,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          filter: { type: 'string' },
          sort: { type: 'string' },
          fields: { type: 'string' },
          search: { type: 'string' },
          offset: { type: 'integer' },
          limit: { type: 'integer' }
        }
      }
    },
    ...createCachedAuthRoute(
      ctx,
      (req) => [
        'miners',
        req.query.filter,
        req.query.sort,
        req.query.fields,
        req.query.search,
        req.query.offset,
        req.query.limit
      ],
      ENDPOINTS.MINERS,
      listMiners,
      [`${AUTH_CAPS.m}:${AUTH_LEVELS.READ}`]
    )
  },
  {
    method: HTTP_METHODS.GET,
    url: ENDPOINTS.CONTAINER_MINERS,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          fields: { type: 'string' },
          overwriteCache: { type: 'boolean' }
        }
      }
    },
    ...createCachedAuthRoute(
      ctx,
      (req) => [
        'containers/miners',
        req.params.id,
        req.query.fields
      ],
      ENDPOINTS.CONTAINER_MINERS,
      listContainerMiners,
      [`${AUTH_CAPS.m}:${AUTH_LEVELS.READ}`]
    )
  },
  {
    method: HTTP_METHODS.GET,
    url: ENDPOINTS.LIST_FIRMWARES,
    ...createCachedAuthRoute(
      ctx,
      (req) => ['list-firmwares'],
      ENDPOINTS.LIST_FIRMWARES,
      listFirmwares
    )
  }
]
