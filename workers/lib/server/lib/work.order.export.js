'use strict'

const { csvEscape } = require('../../utils')
const { RMA_COLUMNS, MINER_MODEL_DISPLAY_NAMES } = require('../../constants')

function displayMinerModel (model) {
  if (!model) return model
  return MINER_MODEL_DISPLAY_NAMES[String(model).toLowerCase()] || model
}

function renderWorkOrderCsv (wo) {
  const { partsMoves, ...woFields } = wo.info || {}
  const base = { code: wo.code, ...woFields }
  const moves = Array.isArray(partsMoves) ? partsMoves : []
  const rawRows = moves.length ? moves.map(move => ({ ...base, ...move })) : [base]
  const rows = rawRows.map(row => (
    row.deviceModel == null ? row : { ...row, deviceModel: displayMinerModel(row.deviceModel) }
  ))

  const headers = []
  const seen = new Set()
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue
      seen.add(key)
      headers.push(key)
    }
  }

  const lines = [headers.map(csvEscape).join(',')]
  for (const row of rows) {
    lines.push(headers.map(h => csvEscape(row[h])).join(','))
  }
  return lines.join('\r\n') + '\r\n'
}

function renderRmaCsv (workOrders) {
  const rows = workOrders.map((wo) => {
    const info = wo.info || {}
    const moves = Array.isArray(info.partsMoves) ? info.partsMoves : []
    const repaired = moves.find(m => m.role === 'repaired') || moves.find(m => m.role === 'diagnosis') || moves[0] || {}
    const replaced = moves.find(m => m.role === 'replacement') || repaired
    const repairTs = info.closedAt ?? info.createdAt
    const minerModel = displayMinerModel(info.deviceModel)
    return [
      wo.code,
      minerModel,
      info.deviceIdentifier,
      repaired.partCode,
      replaced.partCode,
      info.issue,
      info.finalResult,
      info.remarks,
      minerModel,
      repairTs ? new Date(repairTs).toISOString().slice(0, 10) : '',
      info.assignedTo ?? info.createdBy
    ]
  })

  const lines = [RMA_COLUMNS, ...rows].map(row => row.map(csvEscape).join(','))
  return lines.join('\r\n') + '\r\n'
}

module.exports = { renderWorkOrderCsv, renderRmaCsv }
