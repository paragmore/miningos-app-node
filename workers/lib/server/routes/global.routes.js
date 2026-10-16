'use strict'

const {
  ENDPOINTS,
  HTTP_METHODS,
  AUTH_CAPS,
  AUTH_PERMISSIONS,
  GLOBAL_DATA_TYPES
} = require('../../constants')
const {
  getGlobalData,
  setGlobalData,
  getFeatureConfig,
  setFeatures,
  getGlobalConfig,
  redactGlobalConfig,
  setGlobalConfig
} = require('../handlers/global.handlers')
const { getSiteName } = require('../handlers/auth.handlers')
const { createAuthRoute, createAuthOnRequest, createCachedAuthRoute, AUTH_ONLY } = require('../lib/routeHelpers')
const { cachedRoute } = require('../lib/cachedRoute')
const { send200 } = require('../lib/send200')

const GLOBAL_DATA_READ_PERMS = {
  [GLOBAL_DATA_TYPES.ALERT_PARAMETERS]: [AUTH_PERMISSIONS.ALERT_CONFIG],
  [GLOBAL_DATA_TYPES.PRODUCTION_COSTS]: [AUTH_PERMISSIONS.REVENUE],
  [GLOBAL_DATA_TYPES.COST_PARAMETERS]: [AUTH_PERMISSIONS.REVENUE],
  [GLOBAL_DATA_TYPES.POOL_REBATES]: [AUTH_PERMISSIONS.REVENUE]
}

module.exports = (ctx) => {
  // Import schemas within the function scope where ctx is available
  const schemas = require('../schemas/global.schemas.js')

  const routes = [
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.GLOBAL_DATA,
      schema: {
        querystring: schemas.query.globalData
      },
      ...createCachedAuthRoute(
        ctx,
        (req) => [
          'global/data',
          req.query.type,
          req.query.gt,
          req.query.gte,
          req.query.lte,
          req.query.lt,
          req.query.limit,
          req.query.offset,
          req.query.reverse,
          req.query.query,
          req.query.sort,
          req.query.fields,
          req.query.groupBy,
          req.query.model
        ],
        ENDPOINTS.GLOBAL_DATA,
        getGlobalData,
        (req) => GLOBAL_DATA_READ_PERMS[req.query.type] || AUTH_ONLY
      )
    },
    {
      method: HTTP_METHODS.POST,
      url: ENDPOINTS.GLOBAL_DATA,
      ...createAuthRoute(ctx, async (ctx, req) => {
        const success = await setGlobalData(ctx, req)
        return { success }
      }, [`${AUTH_CAPS.f}:w`]),
      schema: {
        body: schemas.body.globalData,
        querystring: schemas.query.type
      }
    },
    ...[ENDPOINTS.FEATURE_CONFIG, ENDPOINTS.FEATURES].map((url) => ({
      method: HTTP_METHODS.GET,
      url,
      ...createAuthRoute(ctx, getFeatureConfig, AUTH_ONLY)
    })),
    {
      method: HTTP_METHODS.POST,
      url: ENDPOINTS.FEATURES,
      ...createAuthRoute(ctx, async (ctx, req) => {
        const success = await setFeatures(ctx, req)
        return { success }
      }, [`${AUTH_CAPS.f}:w`]),
      schema: {
        body: schemas.body.features
      }
    },
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.GLOBAL_CONFIG,
      schema: {
        querystring: schemas.query.globalConfig
      },
      onRequest: createAuthOnRequest(ctx, AUTH_ONLY),
      // The cache holds the full config; revenue-only keys are dropped per caller after it.
      handler: async (req, rep) => {
        const results = await cachedRoute(
          ctx,
          ['global-config'],
          ENDPOINTS.GLOBAL_CONFIG,
          () => getGlobalConfig(ctx, req, rep),
          !!req.query.overwriteCache
        )
        return send200(rep, await redactGlobalConfig(ctx, req, results))
      }
    },
    {
      method: HTTP_METHODS.POST,
      url: ENDPOINTS.GLOBAL_CONFIG,
      ...createAuthRoute(ctx, async (ctx, req) => {
        const success = await setGlobalConfig(ctx, req)
        return { success }
      }, [`${AUTH_CAPS.f}:w`]),
      schema: {
        body: schemas.body.globalConfig
      }
    },
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.SITE,
      ...createAuthRoute(ctx, () => getSiteName(ctx), AUTH_ONLY)
    }
  ]

  return routes
}
