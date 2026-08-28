'use strict'

const { RPC_METHODS, WORKER_TYPES, ELECTRICITY_EXT_DATA_KEYS } = require('../../../../constants')
const { formatDateTime, formatHourLocal } = require('../mappers')

const SUMMARY_KEYS = [
  'againstMiningPercent',
  'againstSellingPercent',
  'expectedRevenue',
  'revenueIfAllMine',
  'revenueIfAllSell'
]

const BASE_COLUMNS = [
  'startUtc', 'endUtc', 'startLocal', 'endLocal', 'spotPrice',
  'miningRevenue', 'miningRevenuePerMwh', 'taxesAndFees', 'taxesAndFeesPerMwh',
  'energySalesRevenue', 'energySalesRevenuePerMwh', 'energySalesTaxesAndFees',
  'energySalesTaxesAndFeesPerMwh', 'energySellPrice', 'energyBuyPrice',
  'decision', 'available'
]

const OVERVIEW_COLUMNS = [...BASE_COLUMNS, 'expectedRevenue', 'expectedRevenuePerMwh']

const AVAILABILITY_KEYS = ['availableEnergy', 'available']

function normalizeAvailability (item) {
  for (const key of AVAILABILITY_KEYS) {
    if (!(key in item)) continue
    const value = item[key]
    if (value === 1 || value === '1' || value === true) return 1
    if (value === 0 || value === '0' || value === false) return 0
  }
  return undefined
}

function toIsoUtc (ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : ''
}

function mapHourlyRow (item, timezone, includeExpected) {
  const start = Number(item.start)
  const end = Number(item.end)
  const row = {
    startUtc: toIsoUtc(start),
    endUtc: toIsoUtc(end),
    startLocal: formatHourLocal(start, timezone),
    endLocal: formatHourLocal(end, timezone),
    spotPrice: item.spotPrice,
    miningRevenue: item.miningRevenue,
    miningRevenuePerMwh: item.miningRevenuePerMwh,
    taxesAndFees: item.taxesAndFees,
    taxesAndFeesPerMwh: item.taxesAndFeesPerMwh,
    energySalesRevenue: item.energySalesRevenue,
    energySalesRevenuePerMwh: item.energySalesRevenuePerMwh,
    energySalesTaxesAndFees: item.energySalesTaxesAndFees,
    energySalesTaxesAndFeesPerMwh: item.energySalesTaxesAndFeesPerMwh,
    energySellPrice: item.energySellPrice,
    energyBuyPrice: item.energyBuyPrice,
    decision: item.decision,
    available: normalizeAvailability(item)
  }
  if (includeExpected) {
    row.expectedRevenue = item.expectedRevenue
    row.expectedRevenuePerMwh = item.expectedRevenuePerMwh
  }
  return row
}

function unwrapPayload (results) {
  const first = Array.isArray(results) ? results[0] : undefined
  return Array.isArray(first) ? first[0] : undefined
}

function pickSummary (payload) {
  const summary = {}
  for (const key of SUMMARY_KEYS) {
    if (payload && key in payload) summary[key] = payload[key]
  }
  return summary
}

function buildForecastEntry ({ type, filenamePrefix, extDataKey, includeExpected, assertParams, buildQuery }) {
  return {
    type,
    perms: ['forecast_overview:r'],
    jsonRootKey: 'hourlyForecast',
    columns: includeExpected ? OVERVIEW_COLUMNS : BASE_COLUMNS,
    filenamePrefix () {
      return filenamePrefix
    },
    assertParams,
    async fetchExport (ctx, { params, now, timezone }) {
      const results = await ctx.dataProxy.requestDataMap(
        RPC_METHODS.GET_WRK_EXT_DATA,
        {
          type: WORKER_TYPES.ELECTRICITY,
          query: { key: extDataKey },
          ...buildQuery(params)
        })
      const payload = unwrapPayload(results)
      const hourly = Array.isArray(payload?.hourlyForecast) ? payload.hourlyForecast : []

      async function * rows () {
        for (const item of hourly) {
          yield mapHourlyRow(item, timezone, includeExpected)
        }
      }
      return {
        rows: rows(),
        jsonMeta: {
          dateExported: formatDateTime(now, timezone),
          summary: pickSummary(payload)
        }
      }
    }
  }
}

const forecastOverview = buildForecastEntry({
  type: 'forecast-overview',
  filenamePrefix: 'forecast_overview_',
  extDataKey: ELECTRICITY_EXT_DATA_KEYS.FORECAST,
  includeExpected: true,
  assertParams () {},
  buildQuery () {
    return {}
  }
})

const historicalForecast = buildForecastEntry({
  type: 'historical-forecast',
  filenamePrefix: 'historical_forecast_',
  extDataKey: ELECTRICITY_EXT_DATA_KEYS.FORECAST_HISTORY,
  includeExpected: false,
  assertParams (params) {
    if (!Number.isFinite(params.start) || !Number.isFinite(params.end)) {
      throw new Error('ERR_EXPORT_RANGE_REQUIRED')
    }
    if (params.start > params.end) throw new Error('ERR_EXPORT_RANGE_INVALID')
  },
  buildQuery (params) {
    return { start: params.start, end: params.end }
  }
})

module.exports = { forecastOverview, historicalForecast }
