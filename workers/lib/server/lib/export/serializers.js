'use strict'

const { Readable } = require('stream')

function objectToString (obj) {
  return `{${Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join(', ')}}`
}

function csvCell (value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => (item && typeof item === 'object' ? objectToString(item) : item))
      .join('; ')
  }
  if (value && typeof value === 'object') return objectToString(value)
  return value ? String(value).replace(/"/g, '""') : ''
}

function csvHeader (columns) {
  return columns.map((key) => String(key).replace(/"/g, '""')).join(',')
}

function csvRecord (columns, row) {
  return columns.map((key) => `"${csvCell(row[key])}"`).join(',')
}

function toCsvStream (rows, columns = null) {
  async function * generate () {
    let cols = columns
    let started = false
    for await (const row of rows) {
      if (!cols) cols = Object.keys(row)
      if (!started) {
        started = true
        yield csvHeader(cols)
      }
      yield '\n' + csvRecord(cols, row)
    }
    if (!started && cols) yield csvHeader(cols)
  }
  return Readable.from(generate())
}

function toJsonStream (rows, { rootKey, meta = {} }) {
  async function * generate () {
    const head = JSON.stringify(meta)
    const prefix = head === '{}' ? '{' : head.slice(0, -1) + ','
    yield prefix + JSON.stringify(rootKey) + ':['
    let first = true
    for await (const row of rows) {
      yield (first ? '' : ',') + JSON.stringify(row)
      first = false
    }
    yield ']}'
  }
  return Readable.from(generate())
}

module.exports = {
  toCsvStream,
  toJsonStream
}
