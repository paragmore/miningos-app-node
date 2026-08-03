'use strict'

const test = require('brittle')
const { renderWorkOrderCsv, renderRmaCsv } = require('../../../workers/lib/server/lib/work.order.export')

const WO = {
  id: 'wo-1',
  code: 'IVI-2-0001',
  info: {
    type: 2,
    status: 'open',
    deviceType: 'psu',
    deviceModel: 'PSU-WM-CB6_V5',
    deviceIdentifier: 'SN-1',
    issue: 'PSU fan dead',
    assignedTo: 'tech@test',
    createdBy: 'op@test',
    createdAt: 1700000000000,
    finalResult: null,
    warranty: { vendor: 'microbt', fields: { rmaNumber: 'RMA-9', faultCode: 'E03' } },
    partsMoves: [
      { ts: 1700000001000, user: 'op@test', role: 'diagnosis', partId: 'p1', partCode: 'PS-1', fromLocation: 'Lab', toLocation: 'Field', fromStatus: 'active', toStatus: 'active' },
      { ts: 1700000002000, user: 'op@test', role: 'replacement', partId: 'p1', partCode: 'PS-1', fromLocation: 'Field', toLocation: 'Lab', fromStatus: 'active', toStatus: 'in_repair' }
    ]
  }
}

test('work.order.export: CSV header is derived from the work order json property names', (t) => {
  const header = renderWorkOrderCsv(WO).split('\r\n')[0].split(',')
  const woKeys = ['code', ...Object.keys(WO.info).filter(k => k !== 'partsMoves')]
  const moveKeys = Object.keys(WO.info.partsMoves[0])
  t.alike(header, [...woKeys, ...moveKeys], 'header is code + info fields + movement fields, not a hardcoded list')
})

test('work.order.export: a new info field appears as a column without code changes', (t) => {
  const wo = { ...WO, info: { ...WO.info, slaBreached: true } }
  const header = renderWorkOrderCsv(wo).split('\r\n')[0].split(',')
  t.ok(header.includes('slaBreached'), 'newly added json field is picked up dynamically')
})

test('work.order.export: CSV emits one row per parts-movement entry', (t) => {
  const csv = renderWorkOrderCsv(WO)
  const lines = csv.trim().split('\r\n')
  t.is(lines.length, 1 + WO.info.partsMoves.length, 'header + one row per move')
  t.ok(lines[1].includes('IVI-2-0001'), 'wo code repeated on each row')
  t.ok(lines[1].includes('diagnosis'))
  t.ok(lines[2].includes('replacement'))
})

test('work.order.export: CSV with no movements still emits a single data row', (t) => {
  const empty = { ...WO, info: { ...WO.info, partsMoves: [] } }
  const csv = renderWorkOrderCsv(empty)
  const lines = csv.trim().split('\r\n')
  t.is(lines.length, 2)
  t.ok(lines[1].startsWith('IVI-2-0001'))
})

test('work.order.export: CSV escapes commas / quotes / newlines in field values', (t) => {
  const wo = { ...WO, info: { ...WO.info, issue: 'fan, broken\nreplaced' } }
  const csv = renderWorkOrderCsv(wo)
  t.ok(csv.includes('"fan, broken\nreplaced"'), 'value with comma/newline wrapped in quotes')
})

test('work.order.export: RMA CSV emits the fixed RMA column header', (t) => {
  t.is(
    renderRmaCsv([]).trim(),
    'Ticket,Repaired type,Repaired Miner Sn,Repaired Mac/HB SN/PSU SN,Replaced Mac/HB SN/PSU SN,Repaired Analyze,Repaired Treatment,Remark,Miner Model,Repair Date,Engineer'
  )
})

test('work.order.export: RMA CSV maps a MicroBT Miner WO to the fixed columns', (t) => {
  const wo = {
    code: 'IVI-3-0001',
    info: {
      type: 3,
      deviceModel: 'M63S++_VL28',
      deviceIdentifier: 'MINER-SN-1',
      issue: 'low hashrate',
      finalResult: 'replaced HB',
      remarks: 'tech remark',
      assignedTo: 'eng@test',
      createdBy: 'op@test',
      closedAt: 1730764800000,
      partsMoves: [
        { role: 'diagnosis', partCode: 'HB-OLD' },
        { role: 'replacement', partCode: 'HB-NEW' }
      ]
    }
  }
  const row = renderRmaCsv([wo]).trim().split('\r\n')[1].split(',')
  t.is(row[0], 'IVI-3-0001', 'Ticket')
  t.is(row[1], 'M63S++_VL28', 'Repaired type')
  t.is(row[2], 'MINER-SN-1', 'Repaired Miner Sn')
  t.is(row[3], 'HB-OLD', 'Repaired part identifier')
  t.is(row[4], 'HB-NEW', 'Replaced part identifier')
  t.is(row[5], 'low hashrate', 'Repaired Analyze')
  t.is(row[6], 'replaced HB', 'Repaired Treatment')
  t.is(row[7], 'tech remark', 'Remark')
  t.is(row[9], new Date(wo.info.closedAt).toISOString().slice(0, 10), 'Repair Date from closedAt')
  t.is(row[10], 'eng@test', 'Engineer')
})

test('work.order.export: RMA CSV maps a known miner type slug to its friendly model name', (t) => {
  const wo = {
    code: 'IVI-1-0090',
    info: {
      type: 1,
      deviceModel: 'miner-wm-m63spp',
      deviceIdentifier: 'MINER-SN-9',
      createdAt: 1730000000000,
      partsMoves: [{ role: 'diagnosis', partCode: 'HB-1' }]
    }
  }
  const row = renderRmaCsv([wo]).trim().split('\r\n')[1].split(',')
  t.is(row[1], 'M63S', 'Repaired type shows the friendly model name, not the worker slug')
  t.is(row[8], 'M63S', 'Miner Model column shows the friendly name too')
})

test('work.order.export: RMA CSV leaves an unmapped deviceModel untouched', (t) => {
  const wo = {
    code: 'IVI-1-0091',
    info: { type: 1, deviceModel: 'miner-am-s21', deviceIdentifier: 'SN', partsMoves: [] }
  }
  const row = renderRmaCsv([wo]).trim().split('\r\n')[1].split(',')
  t.is(row[1], 'miner-am-s21', 'unmapped model falls back to the raw value')
})

test('work.order.export: CSV maps a known miner type slug in the deviceModel column', (t) => {
  const wo = { ...WO, info: { ...WO.info, deviceModel: 'miner-wm-m63spp', partsMoves: [] } }
  const lines = renderWorkOrderCsv(wo).trim().split('\r\n')
  const idx = lines[0].split(',').indexOf('deviceModel')
  t.is(lines[1].split(',')[idx], 'M63S', 'deviceModel column shows the friendly model name')
})
