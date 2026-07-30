'use strict'
const {
  ENDPOINTS,
  HTTP_METHODS,
  ACTIONS_QUERIES_MAX_LENGTH,
  AUTH_PERMISSIONS
} = require('../../constants')
const {
  queryActions,
  queryActionsBatch,
  getAction,
  pushAction,
  voteAction,
  cancelActionsBatch,
  pushActionsBatch,
  downloadLogFile
} = require('../handlers/actions.handlers')
const { createAuthRoute, createCachedAuthRoute, createAuthOnRequest } = require('../lib/routeHelpers')

const ACTIONS_PERMS = [AUTH_PERMISSIONS.ACTIONS]

module.exports = (ctx) => {
  return [
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.ACTIONS,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            queries: { type: 'string', maxLength: ACTIONS_QUERIES_MAX_LENGTH },
            overwriteCache: { type: 'boolean' },
            groupBatch: { type: 'boolean' },
            suffix: { type: 'string', maxLength: 200 }
          },
          required: ['queries']
        }
      },
      ...createCachedAuthRoute(
        ctx,
        (req) => ['actions', req.query.queries, req.query.groupBatch],
        ENDPOINTS.ACTIONS,
        queryActions,
        ACTIONS_PERMS
      )
    },
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.ACTIONS_BATCH,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            ids: {
              type: 'string',
              pattern: '^\\d+(,\\d+)*$'
            },
            overwriteCache: { type: 'boolean' }
          },
          required: ['ids']
        }
      },
      ...createCachedAuthRoute(
        ctx,
        (req) => ['actions/batch', req.query.ids],
        ENDPOINTS.ACTIONS_BATCH,
        queryActionsBatch,
        ACTIONS_PERMS
      )
    },
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.ACTIONS_SINGLE,
      schema: {
        params: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            id: { type: 'integer' },
            overwriteCache: { type: 'boolean' }
          },
          required: ['type', 'id']
        }
      },
      ...createCachedAuthRoute(
        ctx,
        (req) => ['actions/:type/:id', req.params.type, req.params.id],
        ENDPOINTS.ACTIONS_SINGLE,
        getAction,
        ACTIONS_PERMS
      )
    },
    {
      method: HTTP_METHODS.POST,
      url: ENDPOINTS.ACTIONS_VOTING,
      schema: {
        body: {
          type: 'object',
          properties: {
            query: { type: 'object' },
            action: { type: 'string' },
            params: { type: 'array' },
            type: { type: 'string' },
            rackType: { type: 'string' }
          },
          required: ['query', 'action', 'params']
        }
      },
      ...createAuthRoute(ctx, pushAction, ACTIONS_PERMS)
    },
    {
      method: HTTP_METHODS.POST,
      url: ENDPOINTS.ACTIONS_VOTING_BATCH,
      schema: {
        body: {
          type: 'object',
          properties: {
            batchActionsPayload: { type: 'array' },
            batchActionUID: { type: 'string' },
            suffix: { type: 'string', maxLength: 200 }
          },
          required: ['batchActionsPayload', 'batchActionUID']
        }
      },
      ...createAuthRoute(ctx, pushActionsBatch, ACTIONS_PERMS)
    },
    {
      method: HTTP_METHODS.PUT,
      url: ENDPOINTS.ACTIONS_VOTE,
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'integer' }
          },
          required: ['id']
        },
        body: {
          type: 'object',
          properties: {
            approve: { type: 'boolean' }
          },
          required: ['approve']
        }
      },
      ...createAuthRoute(ctx, voteAction, ACTIONS_PERMS)
    },
    {
      method: HTTP_METHODS.DELETE,
      url: ENDPOINTS.ACTIONS_CANCEL,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            ids: {
              type: 'string',
              pattern: '^\\d+(,\\d+)*$'
            }
          },
          required: ['ids']
        }
      },
      ...createAuthRoute(ctx, cancelActionsBatch, ACTIONS_PERMS)
    },
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.DOWNLOAD_LOGS,
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' }
          },
          required: ['id']
        }
      },
      onRequest: createAuthOnRequest(ctx, ACTIONS_PERMS),
      handler: (req, reply) => downloadLogFile(ctx, req, reply)
    }
  ]
}
