'use strict'

const test = require('brittle')
const {
  getCoolingSystemData,
  getFieldProjection,
  buildCoolingViewData,
  buildMinersCircuit1View,
  buildMinersCircuit2View,
  buildHvacCircuit1View,
  buildHvacAmbientView
} = require('../../../workers/lib/server/handlers/coolingSystem.handlers')
const { COOLING_SYSTEM_PROJECTIONS } = require('../../../workers/lib/constants')
const { extractDcsThing, getDCSTag, isCentralDCSEnabled } = require('../../../workers/lib/dcs.utils')

// Sample enriched equipment data (as provided by the DCS worker)
// All data includes units - app-node is completely agnostic
const createMockEquipment = () => ({
  pumps: [
    { equipment: 'B-7513', circuit: 'MINER_LOOP', status: 'Running', FbkRunOut: true, speed: { value: 100, unit: '%' }, current: { value: 42.3, unit: 'A' }, Trip: false },
    { equipment: 'B-7514', circuit: 'MINER_LOOP', status: 'Running', FbkRunOut: true, speed: { value: 100, unit: '%' }, current: { value: 41.8, unit: 'A' }, Trip: false },
    { equipment: 'B-7515', circuit: 'MINER_LOOP', status: 'Standby', FbkRunOut: false, speed: { value: 0, unit: '%' }, current: { value: 0, unit: 'A' }, Trip: false },
    { equipment: 'B-7516', circuit: 'COOLING_TOWER', status: 'Running', FbkRunOut: true, speed: { value: 100, unit: '%' }, current: { value: 48.1, unit: 'A' }, Trip: false },
    { equipment: 'B-7517', circuit: 'COOLING_TOWER', status: 'Running', FbkRunOut: true, speed: { value: 100, unit: '%' }, current: { value: 47.6, unit: 'A' }, Trip: false },
    { equipment: 'B-7501', circuit: 'HVAC_RETURN', status: 'Running', FbkRunOut: true, speed: { value: 100, unit: '%' }, current: { value: 15.2, unit: 'A' }, Trip: false },
    { equipment: 'B-7502', circuit: 'HVAC_SUPPLY', status: 'Running', FbkRunOut: true, speed: { value: 100, unit: '%' }, current: { value: 14.8, unit: 'A' }, Trip: false },
    { equipment: 'B-7503', circuit: 'HVAC_CONDENSER', status: 'Running', FbkRunOut: true, speed: { value: 100, unit: '%' }, current: { value: 22.1, unit: 'A' }, Trip: false }
  ],
  temperatures: [
    { equipment: 'TS-7513', value: 37.1, unit: '°C' },
    { equipment: 'TS-7514', value: 37.3, unit: '°C' },
    { equipment: 'TS-7515', value: 44.6, unit: '°C' },
    { equipment: 'TS-7516', value: 45.0, unit: '°C' },
    { equipment: 'TS-7521', value: 37.0, unit: '°C' },
    { equipment: 'TS-7522', value: 37.1, unit: '°C' },
    { equipment: 'TS-7501', value: 7.2, unit: '°C' },
    { equipment: 'TS-7502', value: 13.8, unit: '°C' }
  ],
  pressures: [
    { equipment: 'PIT-7502', value: 2.9, unit: 'bar' },
    { equipment: 'PIT-7503', value: 1.4, unit: 'bar' },
    { equipment: 'PIT-7504', value: 2.7, unit: 'bar' },
    { equipment: 'PIT-7505', value: 1.3, unit: 'bar' },
    { equipment: 'PIT-7501', value: 3.1, unit: 'bar' }
  ],
  flows: [
    { equipment: 'FIT-7513', value: 192.4, unit: 'm³/h' },
    { equipment: 'FIT-7514', value: 191.6, unit: 'm³/h' },
    { equipment: 'FIT-7501', value: 35.3, unit: 'm³/h' },
    { equipment: 'FIT-7502', value: 35.3, unit: 'm³/h' }
  ],
  levels: [
    { equipment: 'LIT-7501', value: 88, unit: '%' },
    { equipment: 'LIT-7502', value: 82, unit: '%' },
    { equipment: 'LIT-7503', value: 76, unit: '%' }
  ],
  heat_exchangers: [
    { equipment: 'TC-7502', is_active: true, miner_side_out_temp: { value: 37.0, unit: '°C' }, tower_side_in_temp: { value: 29.1, unit: '°C' }, tower_side_out_temp: { value: 36.8, unit: '°C' }, tcv_position: { value: 45, unit: '%' } },
    { equipment: 'TC-7501', is_active: true, miner_side_out_temp: { value: 37.1, unit: '°C' }, tower_side_in_temp: { value: 29.2, unit: '°C' }, tower_side_out_temp: { value: 36.9, unit: '°C' }, tcv_position: { value: 55, unit: '%' } }
  ],
  cooling_towers: [
    { equipment: 'TR-7501', is_running: true, fan_status: 'Running', fan_power: { value: 60, unit: 'kW' }, level: { value: 82, unit: '%' }, vibration: { value: 0.8, unit: 'mm/s', status: 'Normal' } },
    { equipment: 'TR-7502', is_running: true, fan_status: 'Running', fan_power: { value: 45, unit: 'kW' }, level: { value: 85, unit: '%' }, vibration: { value: 0.6, unit: 'mm/s', status: 'Normal' } }
  ],
  valves: [
    { equipment: 'PCV-7502', position: { value: 12, unit: '%' } },
    { equipment: 'PCV-7501', position: { value: 15, unit: '%' } },
    { equipment: 'TCV-7501', position: { value: 55, unit: '%' } },
    { equipment: 'TCV-7502', position: { value: 45, unit: '%' } },
    { equipment: 'LCV-7501', position: { value: 25, unit: '%' } },
    { equipment: 'LCV-7502', position: { value: 0, unit: '%' } }
  ],
  tanks: [
    { equipment: 'TQ-7501' },
    { equipment: 'TQ-7502' }
  ],
  chillers: [
    { equipment: 'CH-7501', is_running: true, mode: 'Auto', cooling_capacity: { value: 275, unit: 'kW' }, power_consumption: { value: 180, unit: 'kW' }, evaporator_temp: { value: 7.2, unit: '°C' }, condenser_temp: { value: 13.8, unit: '°C' } }
  ],
  fan_coils: [
    { equipment: 'FC-7513', is_running: true, temperature: { value: 27.5, unit: '°C' }, valve_position: { value: 45, unit: '%' } },
    { equipment: 'FC-7514', is_running: true, temperature: { value: 27.3, unit: '°C' }, valve_position: { value: 42, unit: '%' } },
    { equipment: 'FC-7529', is_running: true, temperature: { value: 27.8, unit: '°C' }, valve_position: { value: 48, unit: '%' } },
    { equipment: 'FC-7530', is_running: false, temperature: { value: 28.1, unit: '°C' }, valve_position: { value: 0, unit: '%' } }
  ],
  humidity_sensors: [
    { equipment: 'HT-7501', value: 42.5, unit: '%' },
    { equipment: 'HT-7502', value: 43.2, unit: '%' },
    { equipment: 'HT-7503', value: 41.8, unit: '%' },
    { equipment: 'HT-7504', value: 44.1, unit: '%' },
    { equipment: 'HT-7505', value: 55.1, unit: '%' }
  ],
  vibration_sensors: [
    { equipment: 'VT-7501', value: 0.6, unit: 'mm/s', status: 'Normal' },
    { equipment: 'VT-7503', value: 0.8, unit: 'mm/s', status: 'Normal' }
  ],
  flow_switches: [
    { equipment: 'FS-7501', is_active: true },
    { equipment: 'FS-7502', is_active: true }
  ]
})

// Sample config data (site-specific cooling system configuration)
// All labels, defaults, and metadata come from config
const createMockConfig = () => ({
  cooling_system: {
    miner_loop: {
      name: 'Circuit 1 - Miner Loop',
      description: 'Cooling Water',
      water_type: 'Cooling Water',
      defaults: {
        supply_temp: { value: 37, unit: '°C' },
        return_temp: { value: 47, unit: '°C' }
      },
      line1: {
        name: 'LINE 1',
        groups: 'Groups 1-8',
        supply_temp_sensor: 'TS-7513',
        return_temp_sensor: 'TS-7515',
        supply_pressure_sensor: 'PIT-7502',
        return_pressure_sensor: 'PIT-7503',
        supply_flow_sensor: 'FIT-7513'
      },
      line2: {
        name: 'LINE 2',
        groups: 'Groups 9-16',
        supply_temp_sensor: 'TS-7514',
        return_temp_sensor: 'TS-7516',
        supply_pressure_sensor: 'PIT-7504',
        return_pressure_sensor: 'PIT-7505',
        supply_flow_sensor: 'FIT-7514'
      },
      control_valves: {
        pressure_bypass: 'PCV-7502'
      }
    },
    cooling_tower_loop: {
      name: 'Circuit 2 - Cooling Tower Loop',
      description: 'Filtered Water',
      water_type: 'Filtered Water',
      makeup: {
        tank: 'TQ-7501',
        level_sensor: 'LIT-7503',
        level_control_valve: 'LCV-7502'
      }
    },
    hvac_chilled_water: {
      name: 'Circuit 1 - Chilled Water Loop',
      defaults: {
        supply_temp: { value: 7, unit: '°C' },
        return_temp: { value: 14, unit: '°C' }
      },
      supply_return: {
        supply_temp_sensor: 'TS-7501',
        return_temp_sensor: 'TS-7502',
        supply_flow_sensor: 'FIT-7501',
        return_flow_sensor: 'FIT-7502',
        pressure_sensor: 'PIT-7501'
      },
      buffer_tank: {
        tank: 'TQ-7502',
        level_sensor: 'LIT-7501',
        makeup_valve: 'LCV-7501'
      },
      control_valves: {
        pressure_bypass: 'PCV-7501'
      }
    },
    hvac_condenser: {
      name: 'Circuit 2 - Condenser Water Loop',
      defaults: {
        supply_temp: { value: 29, unit: '°C' },
        return_temp: { value: 39, unit: '°C' }
      }
    },
    ambient: {
      rooms: [
        { name: 'Miner Room 1', fan_coils: ['FC-7513', 'FC-7514'], humidity_sensors: ['HT-7501'] },
        { name: 'Miner Room 2', fan_coils: ['FC-7529', 'FC-7530'], humidity_sensors: ['HT-7502'] }
      ],
      ambient_sensors: ['HT-7505']
    },
    view_metadata: {
      miners: {
        layout: { title: 'Miners Cooling Layout', description: 'Complete cooling system overview' }
      },
      hvac: {
        layout: { title: 'HVAC Cooling Layout', description: 'Complete HVAC cooling system overview' },
        ambient: { title: 'Ambient Conditions', description: 'Room temperatures and humidity levels' }
      }
    }
  }
})

// Sample snap data with enriched equipment data
const createMockSnapData = () => ({
  success: true,
  stats: {
    dcs_specific: {
      equipment: createMockEquipment()
    },
    flow: {
      miner_loop: { value: 384, unit: 'm³/h' },
      cooling_tower: { value: 800, unit: 'm³/h' }
    },
    humidity: {
      avg: 45.3,
      min: 41.8,
      max: 55.1
    }
  },
  config: createMockConfig()
})

function createMockCtx (featureEnabled = true, customDcsResponse = null) {
  const snapData = createMockSnapData()
  const defaultResponse = [[{
    id: 'dcs-1',
    type: 'dcs',
    tags: ['t-dcs'],
    last: { snap: snapData }
  }]]

  const featureConfig = {
    centralDCSSetup: {
      enabled: featureEnabled,
      tag: 't-dcs'
    }
  }

  return {
    conf: {
      featureConfig,
      orks: [{ rpcPublicKey: 'key1' }]
    },
    dataProxy: {
      requestDataMap: async () => {
        return customDcsResponse !== null ? customDcsResponse : defaultResponse
      }
    }
  }
}

// Feature flag tests
test('isCentralDCSEnabled - returns true with new config', (t) => {
  const ctx = { conf: { featureConfig: { centralDCSSetup: { enabled: true } } } }
  t.is(isCentralDCSEnabled(ctx), true)
  t.pass()
})

test('isCentralDCSEnabled - ignores legacy config key', (t) => {
  const ctx = { conf: { featureConfig: { isCentralPCS7Setup: true } } }
  t.is(isCentralDCSEnabled(ctx), false)
  t.pass()
})

test('isCentralDCSEnabled - returns false when disabled', (t) => {
  const ctx = { conf: { featureConfig: { centralDCSSetup: { enabled: false } } } }
  t.is(isCentralDCSEnabled(ctx), false)
  t.pass()
})

// DCS Tag tests
test('getDCSTag - returns configured tag', (t) => {
  const ctx = { conf: { featureConfig: { centralDCSSetup: { tag: 't-custom-dcs' } } } }
  t.is(getDCSTag(ctx), 't-custom-dcs')
  t.pass()
})

test('getDCSTag - returns default tag when not configured', (t) => {
  const ctx = { conf: { featureConfig: {} } }
  t.is(getDCSTag(ctx), 't-dcs')
  t.pass()
})

// Field projection tests
test('getFieldProjection - returns correct projection for miners/circuit1', (t) => {
  const projection = getFieldProjection('miners', 'circuit1')
  t.ok(projection.id, 'should have base field id')
  t.ok(projection['last.snap.stats.dcs_specific.equipment.pumps'], 'should have pumps projection')
  t.ok(projection['last.snap.stats.dcs_specific.equipment.temperatures'], 'should have temperatures projection')
  t.ok(projection['last.snap.config.cooling_system'], 'should have config projection')
  t.pass()
})

test('getFieldProjection - returns correct projection for hvac/ambient', (t) => {
  const projection = getFieldProjection('hvac', 'ambient')
  t.ok(projection.id, 'should have base field id')
  t.ok(projection['last.snap.stats.dcs_specific.equipment.fan_coils'], 'should have fan_coils projection')
  t.ok(projection['last.snap.stats.dcs_specific.equipment.humidity_sensors'], 'should have humidity_sensors projection')
  t.pass()
})

test('COOLING_SYSTEM_PROJECTIONS - has correct structure', (t) => {
  t.ok(COOLING_SYSTEM_PROJECTIONS.base, 'should have base projection')
  t.ok(COOLING_SYSTEM_PROJECTIONS.miners, 'should have miners projections')
  t.ok(COOLING_SYSTEM_PROJECTIONS.hvac, 'should have hvac projections')
  t.ok(COOLING_SYSTEM_PROJECTIONS.miners.circuit1, 'should have miners.circuit1')
  t.ok(COOLING_SYSTEM_PROJECTIONS.miners.circuit2, 'should have miners.circuit2')
  t.ok(COOLING_SYSTEM_PROJECTIONS.miners.layout, 'should have miners.layout')
  t.ok(COOLING_SYSTEM_PROJECTIONS.hvac.circuit1, 'should have hvac.circuit1')
  t.ok(COOLING_SYSTEM_PROJECTIONS.hvac.circuit2, 'should have hvac.circuit2')
  t.ok(COOLING_SYSTEM_PROJECTIONS.hvac.layout, 'should have hvac.layout')
  t.ok(COOLING_SYSTEM_PROJECTIONS.hvac.ambient, 'should have hvac.ambient')
  t.pass()
})

// Extract DCS thing tests
test('extractDcsThing - extracts thing from valid results', (t) => {
  const snapData = createMockSnapData()
  const rpcResults = [[{
    id: 'dcs-1',
    type: 'dcs',
    tags: ['t-dcs'],
    last: { snap: snapData }
  }]]

  const thing = extractDcsThing(rpcResults)
  t.ok(thing, 'should extract thing')
  t.is(thing.type, 'dcs', 'should have correct type')
  t.ok(thing.last.snap, 'should have snap data')
  t.pass()
})

test('extractDcsThing - returns null for empty results', (t) => {
  const thing = extractDcsThing([])
  t.is(thing, null)
  t.pass()
})

test('extractDcsThing - returns null for non-array', (t) => {
  const thing = extractDcsThing(null)
  t.is(thing, null)
  t.pass()
})

// View builder tests
test('buildMinersCircuit1View - builds view from enriched equipment', (t) => {
  const equipment = createMockEquipment()
  const config = createMockConfig()
  const view = buildMinersCircuit1View(equipment, config)

  t.ok(view, 'should return view')
  t.is(view.title, 'Circuit 1 - Miner Loop', 'title from config')
  t.is(view.water_type, 'Cooling Water', 'water_type from config')
  t.ok(view.lines, 'should have lines')
  t.is(view.lines.length, 2, 'should have 2 lines')
  t.ok(view.pumps, 'should have pumps')
  t.is(view.pumps.length, 3, 'should have 3 miner loop pumps')
  // Check enriched data with units
  t.ok(view.pumps[0].speed.unit, 'pump speed should have unit')
  t.ok(view.pumps[0].current.unit, 'pump current should have unit')
  t.pass()
})

test('buildMinersCircuit2View - builds view from enriched equipment', (t) => {
  const equipment = createMockEquipment()
  const config = createMockConfig()
  const view = buildMinersCircuit2View(equipment, config)

  t.ok(view, 'should return view')
  t.is(view.title, 'Circuit 2 - Cooling Tower Loop', 'title from config')
  t.ok(view.cooling_towers, 'should have cooling_towers')
  t.ok(view.makeup_tank, 'should have makeup_tank')
  t.ok(view.heat_exchanger_temps, 'should have heat_exchanger_temps')
  // Check enriched data with units
  t.ok(view.cooling_towers[0].fan_power.unit, 'fan_power should have unit')
  t.ok(view.cooling_towers[0].level.unit, 'level should have unit')
  t.pass()
})

test('buildHvacCircuit1View - builds view from enriched equipment', (t) => {
  const equipment = createMockEquipment()
  const config = createMockConfig()
  const view = buildHvacCircuit1View(equipment, config)

  t.ok(view, 'should return view')
  t.is(view.title, 'Circuit 1 - Chilled Water Loop', 'title from config')
  t.ok(view.chiller, 'should have chiller')
  t.is(view.chiller.is_running, true, 'chiller should be running')
  // Check enriched data with units
  t.ok(view.chiller.cooling_capacity.unit, 'cooling_capacity should have unit')
  t.ok(view.chiller.evaporator_temp.unit, 'evaporator_temp should have unit')
  t.pass()
})

test('buildHvacAmbientView - builds view from enriched equipment', (t) => {
  const equipment = createMockEquipment()
  const config = createMockConfig()
  const stats = { humidity: { avg: 45.3 } }
  const view = buildHvacAmbientView(equipment, config, stats)

  t.ok(view, 'should return view')
  t.ok(view.rooms, 'should have rooms')
  t.is(view.rooms.length, 2, 'should have 2 rooms from config')
  t.is(view.rooms[0].name, 'Miner Room 1', 'room name from config')
  // Check fan coil enriched data
  t.ok(view.rooms[0].fan_coils[0].temperature.unit, 'fan coil temp should have unit')
  t.pass()
})

// buildCoolingViewData tests
test('buildCoolingViewData - returns miners circuit1 data', (t) => {
  const snap = createMockSnapData()
  const data = buildCoolingViewData(snap, 'miners', 'circuit1')

  t.ok(data, 'should return data')
  t.ok(data.title, 'should have title')
  t.ok(data.lines, 'should have lines')
  t.ok(data.pumps, 'should have pumps')
  t.pass()
})

test('buildCoolingViewData - returns miners circuit2 data', (t) => {
  const snap = createMockSnapData()
  const data = buildCoolingViewData(snap, 'miners', 'circuit2')

  t.ok(data, 'should return data')
  t.ok(data.cooling_towers, 'should have cooling_towers')
  t.ok(data.makeup_tank, 'should have makeup_tank')
  t.pass()
})

test('buildCoolingViewData - returns hvac circuit1 data', (t) => {
  const snap = createMockSnapData()
  const data = buildCoolingViewData(snap, 'hvac', 'circuit1')

  t.ok(data, 'should return data')
  t.ok(data.chiller, 'should have chiller')
  t.ok(data.supply_return, 'should have supply_return')
  t.pass()
})

test('buildCoolingViewData - returns hvac ambient data', (t) => {
  const snap = createMockSnapData()
  const data = buildCoolingViewData(snap, 'hvac', 'ambient')

  t.ok(data, 'should return data')
  t.ok(data.rooms, 'should have rooms')
  t.is(data.rooms.length, 2, 'should have 2 rooms')
  t.pass()
})

test('buildCoolingViewData - returns null for invalid type', (t) => {
  const snap = createMockSnapData()
  const data = buildCoolingViewData(snap, 'invalid', 'circuit1')

  t.is(data, null, 'should return null')
  t.pass()
})

// getCoolingSystemData integration tests
test('getCoolingSystemData - returns miners circuit1 data', async (t) => {
  const ctx = createMockCtx(true)
  const req = { query: { type: 'miners', view: 'circuit1' } }

  const result = await getCoolingSystemData(ctx, req)

  t.is(result.type, 'miners', 'type should be miners')
  t.is(result.view, 'circuit1', 'view should be circuit1')
  t.ok(result.data, 'should have data')
  t.ok(result.data.title, 'should have title from config')
  t.ok(result.data.lines, 'should have lines')
  t.ok(result.data.pumps, 'should have pumps')
  t.pass()
})

test('getCoolingSystemData - returns miners circuit2 data', async (t) => {
  const ctx = createMockCtx(true)
  const req = { query: { type: 'miners', view: 'circuit2' } }

  const result = await getCoolingSystemData(ctx, req)

  t.is(result.type, 'miners', 'type should be miners')
  t.is(result.view, 'circuit2', 'view should be circuit2')
  t.ok(result.data, 'should have data')
  t.ok(result.data.cooling_towers, 'should have cooling_towers')
  t.pass()
})

test('getCoolingSystemData - returns hvac circuit1 data', async (t) => {
  const ctx = createMockCtx(true)
  const req = { query: { type: 'hvac', view: 'circuit1' } }

  const result = await getCoolingSystemData(ctx, req)

  t.is(result.type, 'hvac', 'type should be hvac')
  t.is(result.view, 'circuit1', 'view should be circuit1')
  t.ok(result.data, 'should have data')
  t.ok(result.data.chiller, 'should have chiller')
  t.pass()
})

test('getCoolingSystemData - returns hvac ambient data', async (t) => {
  const ctx = createMockCtx(true)
  const req = { query: { type: 'hvac', view: 'ambient' } }

  const result = await getCoolingSystemData(ctx, req)

  t.is(result.type, 'hvac', 'type should be hvac')
  t.is(result.view, 'ambient', 'view should be ambient')
  t.ok(result.data, 'should have data')
  t.ok(result.data.rooms, 'should have rooms')
  t.pass()
})

test('getCoolingSystemData - throws error when feature disabled', async (t) => {
  const ctx = createMockCtx(false)
  const req = { query: { type: 'miners', view: 'circuit1' } }

  try {
    await getCoolingSystemData(ctx, req)
    t.fail('should throw error')
  } catch (err) {
    t.is(err.message, 'ERR_FEATURE_NOT_ENABLED', 'should throw ERR_FEATURE_NOT_ENABLED')
  }
  t.pass()
})

test('getCoolingSystemData - throws error for invalid type', async (t) => {
  const ctx = createMockCtx(true)
  const req = { query: { type: 'invalid', view: 'circuit1' } }

  try {
    await getCoolingSystemData(ctx, req)
    t.fail('should throw error')
  } catch (err) {
    t.is(err.message, 'ERR_INVALID_TYPE', 'should throw ERR_INVALID_TYPE')
  }
  t.pass()
})

test('getCoolingSystemData - throws error for invalid view', async (t) => {
  const ctx = createMockCtx(true)
  const req = { query: { type: 'miners', view: 'invalid' } }

  try {
    await getCoolingSystemData(ctx, req)
    t.fail('should throw error')
  } catch (err) {
    t.is(err.message, 'ERR_INVALID_VIEW', 'should throw ERR_INVALID_VIEW')
  }
  t.pass()
})

test('getCoolingSystemData - throws error when DCS data not found', async (t) => {
  const ctx = createMockCtx(true, [])
  const req = { query: { type: 'miners', view: 'circuit1' } }

  try {
    await getCoolingSystemData(ctx, req)
    t.fail('should throw error')
  } catch (err) {
    t.is(err.message, 'ERR_DCS_DATA_NOT_FOUND', 'should throw ERR_DCS_DATA_NOT_FOUND')
  }
  t.pass()
})
