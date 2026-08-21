'use strict'

const DEFAULT_TIMEZONE = 'UTC'

function assertTimezone (timezone) {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return timezone
  } catch (err) {
    throw new Error('ERR_EXPORT_TIMEZONE_INVALID')
  }
}

function dateTimeParts (date, timezone, options) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    ...options
  }).formatToParts(date)
  const byType = {}
  for (const { type, value } of parts) byType[type] = value
  return byType
}

function formatDateTime (date, timezone) {
  const p = dateTimeParts(date, timezone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}:${p.second}`
}

function formatDateLabel (date, timezone) {
  const p = dateTimeParts(date, timezone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  return `${p.day}-${p.month}-${p.year}_${p.hour}-${p.minute}-${p.second}`
}

function formatHourLocal (ts, timezone) {
  const ms = Number(ts)
  if (ts === null || ts === undefined || !Number.isFinite(ms)) return ''
  const p = dateTimeParts(new Date(ms), timezone, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
  return `${p.weekday}, ${p.month} ${p.day} · ${p.hour}:${p.minute}`
}

function getMinerShortCode (code, tags) {
  if (code) return code
  const codeTag = (tags || []).find(
    (tag) => typeof tag === 'string' && tag.startsWith('code-') && !tag.endsWith('undefined')
  )
  return codeTag ? codeTag.replace('code-', '') : 'N/A'
}

function splitPoolWorker (username) {
  const names = String(username ?? '').split('.')
  if (names.length > 1) return { poolName: names[0], workerName: names[1] }
  return { workerName: names[0] }
}

// Flat temperature columns, shared so the miner and container-miner exports
// stay column-compatible. The nested `temperatureC` object stays alongside
// them: it is fine in JSON, but the CSV serializer flattens only one level, so
// a reading nested inside it is unreadable in a spreadsheet.
const TEMPERATURE_COLUMNS = [
  'temperatureAmbientC',
  'temperatureLiquidInletC',
  'temperatureMaxC',
  'temperatureAvgC'
]

// `undefined`, not 0, when a miner reports no liquid loop: JSON then omits the
// key and CSV renders an empty cell, so air-cooled reads as "no sensor"
// rather than "0 degrees".
function mapTemperatureColumns (temperatureC) {
  return {
    temperatureAmbientC: temperatureC?.ambient,
    temperatureLiquidInletC: temperatureC?.liquid_inlet,
    temperatureMaxC: temperatureC?.max,
    temperatureAvgC: temperatureC?.avg
  }
}

module.exports = {
  DEFAULT_TIMEZONE,
  TEMPERATURE_COLUMNS,
  assertTimezone,
  formatDateTime,
  formatDateLabel,
  formatHourLocal,
  getMinerShortCode,
  mapTemperatureColumns,
  splitPoolWorker
}
