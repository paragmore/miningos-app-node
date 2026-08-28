'use strict'

const { toCsvStream, toJsonStream } = require('./serializers')
const { DEFAULT_TIMEZONE, assertTimezone, formatDateLabel } = require('./mappers')
const minerStats = require('./types/minerStats.export')
const containerMinerStats = require('./types/containerMinerStats.export')
const { forecastOverview, historicalForecast } = require('./types/forecast.export')
const historicalMinerKpi = require('./types/historicalMinerKpi.export')
const { invoicingHourlyHashes, invoicingDailyHashes, invoiceBreakdown } = require('./types/invoicing.export')

const TYPES = [
  minerStats,
  containerMinerStats,
  forecastOverview,
  historicalForecast,
  historicalMinerKpi,
  invoicingHourlyHashes,
  invoicingDailyHashes,
  invoiceBreakdown
]

const REGISTRY = new Map(TYPES.map((entry) => [entry.type, entry]))

const EXPORT_TYPES = TYPES.map((entry) => entry.type)
const EXPORT_FORMATS = ['csv', 'json']
const EXPORT_CONTENT_TYPES = {
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8'
}

function getExportType (type) {
  return REGISTRY.get(type) || null
}

async function peekRows (rows) {
  const iterator = rows[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done) return null
  return (async function * () {
    yield first.value
    yield * iterator
  })()
}

async function resolveExport (ctx, entry, params) {
  const timezone = assertTimezone(params.timezone || DEFAULT_TIMEZONE)
  const format = EXPORT_FORMATS.includes(params.format) ? params.format : 'csv'
  const now = new Date()

  const { rows, jsonMeta } = await entry.fetchExport(ctx, { params, now, timezone })
  const peeked = await peekRows(rows)
  if (!peeked) throw new Error('ERR_EXPORT_NO_DATA')

  const filename = `${entry.filenamePrefix(params)}${formatDateLabel(now, timezone)}.${format}`
  const stream = format === 'json'
    ? toJsonStream(peeked, { rootKey: entry.jsonRootKey, meta: jsonMeta })
    : toCsvStream(peeked, entry.columns)

  return { filename, contentType: EXPORT_CONTENT_TYPES[format], stream }
}

module.exports = {
  EXPORT_TYPES,
  EXPORT_FORMATS,
  getExportType,
  resolveExport
}
