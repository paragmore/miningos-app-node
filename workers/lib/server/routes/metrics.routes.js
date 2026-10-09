'use strict'

const {
  ENDPOINTS,
  HTTP_METHODS,
  AUTH_PERMISSIONS
} = require('../../constants')
const {
  wantsMonthlyRollup,
  downtimeUsesTimezone,
  getHashrate,
  getPoolHashrate,
  getConsumption,
  getEfficiency,
  getMinerStatus,
  getMinersByContainer,
  getInventorySummary,
  getMinersByType,
  getInventoryMinerDistribution,
  getPowerMode,
  getPowerModeTimeline,
  getTemperature,
  getCooling,
  getDowntime,
  getContainerTelemetry,
  getContainerHistory
} = require('../handlers/metrics.handlers')
const { getSiteLiveStatus } = require('../handlers/site.handlers')
const { getRevenueHourly } = require('../handlers/finance.handlers')
const { createCachedAuthRoute, rejectTimezone, AUTH_ONLY } = require('../lib/routeHelpers')

module.exports = (ctx) => {
  const schemas = require('../schemas/metrics.schemas.js')

  return [
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.METRICS_HASHRATE,
      schema: {
        querystring: schemas.query.hashrate
      },
      // Only the calendar-month rollup (1M without groupBy/racks) cuts on the zone.
      preValidation: rejectTimezone(wantsMonthlyRollup),
      ...createCachedAuthRoute(
        ctx,
        (req) => [
          'metrics/hashrate',
          req.query.phase,
          req.query.start,
          req.query.end,
          req.query.interval,
          req.query.timezone,
          req.query.groupBy,
          req.query.container,
          req.query.current,
          req.query.nominal,
          req.query.siteNominal,
          req.query.pool,
          req.query.racks,
          req.query.offset,
          req.query.limit,
          req.query.reverse
        ],
        ENDPOINTS.METRICS_HASHRATE,
        getHashrate,
        AUTH_ONLY
      )
    },
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.METRICS_POOL_HASHRATE,
      schema: {
        querystring: schemas.query.poolHashrate
      },
      preValidation: rejectTimezone(),
      ...createCachedAuthRoute(
        ctx,
        (req) => ['metrics/pool-hashrate', req.query.interval, req.query.lookbackDays, req.query.phase],
        ENDPOINTS.METRICS_POOL_HASHRATE,
        getPoolHashrate,
        [AUTH_PERMISSIONS.MINERPOOL]
      )
    },
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.METRICS_CONSUMPTION,
      schema: {
        querystring: schemas.query.consumption
      },
      preValidation: rejectTimezone(),
      ...createCachedAuthRoute(
        ctx,
        (req) => [
          'metrics/consumption',
          req.query.phase,
          req.query.start,
          req.query.end,
          req.query.interval,
          req.query.groupBy,
          req.query.byMeter,
          req.query.racks
        ],
        ENDPOINTS.METRICS_CONSUMPTION,
        getConsumption,
        AUTH_ONLY
      )
    },
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.METRICS_EFFICIENCY,
      schema: {
        querystring: schemas.query.efficiency
      },
      preValidation: rejectTimezone(),
      ...createCachedAuthRoute(
        ctx,
        (req) => [
          'metrics/efficiency',
          req.query.phase,
          req.query.start,
          req.query.end,
          req.query.interval,
          req.query.groupBy,
          req.query.racks
        ],
        ENDPOINTS.METRICS_EFFICIENCY,
        getEfficiency,
        [AUTH_PERMISSIONS.REPORTING]
      )
    },
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.METRICS_MINER_STATUS,
      schema: {
        querystring: schemas.query.minerStatus
      },
      preValidation: rejectTimezone(),
      ...createCachedAuthRoute(
        ctx,
        (req) => [
          'metrics/miner-status',
          req.query.start,
          req.query.end,
          req.query.groupBy
        ],
        ENDPOINTS.METRICS_MINER_STATUS,
        getMinerStatus,
        [AUTH_PERMISSIONS.REPORTING]
      )
    },
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.METRICS_MINERS_BY_CONTAINER,
      schema: {
        querystring: schemas.query.minersByContainer
      },
      ...createCachedAuthRoute(
        ctx,
        () => ['metrics/miners/by-container'],
        ENDPOINTS.METRICS_MINERS_BY_CONTAINER,
        getMinersByContainer,
        AUTH_ONLY
      )
    },
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.METRICS_SITE_SUMMARY,
      schema: {
        querystring: schemas.query.siteSummary
      },
      ...createCachedAuthRoute(
        ctx,
        () => ['metrics/site/summary'],
        ENDPOINTS.METRICS_SITE_SUMMARY,
        getSiteLiveStatus,
        AUTH_ONLY
      )
    },
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.METRICS_INVENTORY_SUMMARY,
      schema: {
        querystring: schemas.query.inventorySummary
      },
      ...createCachedAuthRoute(
        ctx,
        () => ['metrics/inventory/summary'],
        ENDPOINTS.METRICS_INVENTORY_SUMMARY,
        getInventorySummary,
        [AUTH_PERMISSIONS.INVENTORY]
      )
    },
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.METRICS_MINERS_BY_TYPE,
      schema: {
        querystring: schemas.query.minersByType
      },
      ...createCachedAuthRoute(
        ctx,
        () => ['metrics/miners/by-type'],
        ENDPOINTS.METRICS_MINERS_BY_TYPE,
        getMinersByType,
        [AUTH_PERMISSIONS.REPORTING]
      )
    },
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.METRICS_INVENTORY_MINER_DISTRIBUTION,
      schema: {
        querystring: schemas.query.inventoryMinerDistribution
      },
      ...createCachedAuthRoute(
        ctx,
        () => ['metrics/inventory/miner-distribution'],
        ENDPOINTS.METRICS_INVENTORY_MINER_DISTRIBUTION,
        getInventoryMinerDistribution,
        [AUTH_PERMISSIONS.INVENTORY]
      )
    },
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.METRICS_REVENUE_HOURLY,
      schema: {
        querystring: schemas.query.revenueHourly
      },
      preValidation: rejectTimezone(),
      ...createCachedAuthRoute(
        ctx,
        (req) => ['metrics/revenue/hourly', req.query.start, req.query.end, req.query.pool],
        ENDPOINTS.METRICS_REVENUE_HOURLY,
        getRevenueHourly,
        [AUTH_PERMISSIONS.REVENUE]
      )
    },
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.METRICS_POWER_MODE,
      schema: {
        querystring: schemas.query.powerMode
      },
      preValidation: rejectTimezone(),
      ...createCachedAuthRoute(
        ctx,
        (req) => [
          'metrics/power-mode',
          req.query.start,
          req.query.end,
          req.query.interval
        ],
        ENDPOINTS.METRICS_POWER_MODE,
        getPowerMode,
        [AUTH_PERMISSIONS.MINER]
      )
    },
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.METRICS_POWER_MODE_TIMELINE,
      schema: {
        querystring: schemas.query.powerModeTimeline
      },
      preValidation: rejectTimezone(),
      ...createCachedAuthRoute(
        ctx,
        (req) => [
          'metrics/power-mode/timeline',
          req.query.start,
          req.query.end,
          req.query.interval,
          req.query.container
        ],
        ENDPOINTS.METRICS_POWER_MODE_TIMELINE,
        getPowerModeTimeline,
        AUTH_ONLY
      )
    },
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.METRICS_TEMPERATURE,
      schema: {
        querystring: schemas.query.temperature
      },
      preValidation: rejectTimezone(),
      ...createCachedAuthRoute(
        ctx,
        (req) => [
          'metrics/temperature',
          req.query.start,
          req.query.end,
          req.query.interval,
          req.query.container
        ],
        ENDPOINTS.METRICS_TEMPERATURE,
        getTemperature,
        [AUTH_PERMISSIONS.MINER, AUTH_PERMISSIONS.CONTAINER]
      )
    },
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.METRICS_COOLING,
      schema: {
        querystring: schemas.query.cooling
      },
      preValidation: rejectTimezone(),
      ...createCachedAuthRoute(
        ctx,
        (req) => [
          'metrics/cooling',
          req.query.start,
          req.query.end,
          req.query.interval
        ],
        ENDPOINTS.METRICS_COOLING,
        getCooling,
        [AUTH_PERMISSIONS.CONTAINER]
      )
    },
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.METRICS_DOWNTIME,
      schema: {
        querystring: schemas.query.downtime
      },
      // Only the daily rollup (interval=1d, or the automatic one for ranges over 2 days)
      // cuts on the zone.
      preValidation: rejectTimezone(downtimeUsesTimezone),
      ...createCachedAuthRoute(
        ctx,
        (req) => [
          'metrics/downtime',
          req.query.phase,
          req.query.start,
          req.query.end,
          req.query.interval,
          req.query.timezone
        ],
        ENDPOINTS.METRICS_DOWNTIME,
        getDowntime,
        [AUTH_PERMISSIONS.REPORTING]
      )
    },
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.METRICS_CONTAINER_HISTORY,
      schema: {
        querystring: schemas.query.containerHistory
      },
      preValidation: rejectTimezone(),
      ...createCachedAuthRoute(
        ctx,
        (req) => [
          'metrics/containers/history',
          req.params.id,
          req.query.start,
          req.query.end,
          req.query.interval,
          req.query.limit
        ],
        ENDPOINTS.METRICS_CONTAINER_HISTORY,
        getContainerHistory,
        [AUTH_PERMISSIONS.CONTAINER]
      )
    },
    {
      method: HTTP_METHODS.GET,
      url: ENDPOINTS.METRICS_CONTAINER_TELEMETRY,
      schema: {
        querystring: schemas.query.containerTelemetry
      },
      ...createCachedAuthRoute(
        ctx,
        (req) => [
          'metrics/containers/telemetry',
          req.params.id
        ],
        ENDPOINTS.METRICS_CONTAINER_TELEMETRY,
        getContainerTelemetry,
        [AUTH_PERMISSIONS.CONTAINER]
      )
    }
  ]
}
