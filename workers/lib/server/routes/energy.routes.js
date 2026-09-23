'use strict'

const { ENDPOINTS, HTTP_METHODS, AUTH_PERMISSIONS } = require('../../constants')
const { getEnergyForecast, setAvailableEnergy, getEnergyForecastHistory, setForecastSettings, getForecastSettings, setForecastOverride, setAvailableEnergyHistory, setForecastOverrideHistory } = require('../handlers/energy.handlers')
const { createCachedAuthRoute, createAuthRoute } = require('../lib/routeHelpers')
const schemas = require('../schemas/energy.schemas')

module.exports = (ctx) => [
  {
    method: HTTP_METHODS.GET,
    url: ENDPOINTS.ENERGY_FORECAST,
    ...createCachedAuthRoute(
      ctx,
      (req) => ['energy-forecast'],
      ENDPOINTS.ENERGY_FORECAST,
      getEnergyForecast,
      [AUTH_PERMISSIONS.FORECAST_SUMMARY]
    )
  },
  {
    method: HTTP_METHODS.GET,
    url: ENDPOINTS.ENERGY_FORECAST_HISTORY,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          start: { type: 'integer', minimum: 0 },
          end: { type: 'integer', minimum: 0 }
        },
        required: ['start', 'end']
      }
    },
    ...createCachedAuthRoute(
      ctx,
      (req) => ['energy-forecast-history', req.query.start, req.query.end],
      ENDPOINTS.ENERGY_FORECAST_HISTORY,
      getEnergyForecastHistory,
      [AUTH_PERMISSIONS.FORECAST_OVERVIEW]
    )
  },
  {
    method: HTTP_METHODS.POST,
    url: ENDPOINTS.ENERGY_AVAILABLE,
    ...createAuthRoute(ctx, async (ctx, req) => {
      return await setAvailableEnergy(ctx, req)
    }, [AUTH_PERMISSIONS.FORECAST_SUMMARY]),
    schema: {
      body: schemas.body.availableEnergy
    }
  },
  {
    method: HTTP_METHODS.POST,
    url: ENDPOINTS.ENERGY_AVAILABLE_HISTORY,
    ...createAuthRoute(ctx, async (ctx, req) => {
      return await setAvailableEnergyHistory(ctx, req)
    }, [AUTH_PERMISSIONS.FORECAST_OVERVIEW]),
    schema: {
      body: schemas.body.availableEnergyHistory
    }
  },
  {
    method: HTTP_METHODS.POST,
    url: ENDPOINTS.ENERGY_FORECAST_SETTINGS,
    ...createAuthRoute(ctx, async (ctx, req) => {
      return await setForecastSettings(ctx, req)
    }, [AUTH_PERMISSIONS.FORECAST_SETTINGS]),
    schema: {
      body: schemas.body.forecastSettings
    }
  },
  {
    method: HTTP_METHODS.GET,
    url: ENDPOINTS.ENERGY_FORECAST_SETTINGS,
    ...createCachedAuthRoute(
      ctx,
      (req) => ['forecast-settings'],
      ENDPOINTS.ENERGY_FORECAST_SETTINGS,
      getForecastSettings,
      [AUTH_PERMISSIONS.FORECAST_SETTINGS]
    )
  },
  {
    method: HTTP_METHODS.POST,
    url: ENDPOINTS.ENERGY_FORECAST_OVERRIDE,
    ...createAuthRoute(ctx, async (ctx, req) => {
      return await setForecastOverride(ctx, req)
    }, [AUTH_PERMISSIONS.FORECAST_OVERVIEW]),
    schema: {
      body: schemas.body.forecastOverride
    }
  },
  {
    method: HTTP_METHODS.POST,
    url: ENDPOINTS.ENERGY_FORECAST_OVERRIDE_HISTORY,
    ...createAuthRoute(ctx, async (ctx, req) => {
      return await setForecastOverrideHistory(ctx, req)
    }, [AUTH_PERMISSIONS.FORECAST_OVERVIEW]),
    schema: {
      body: schemas.body.forecastOverride
    }
  }
]
