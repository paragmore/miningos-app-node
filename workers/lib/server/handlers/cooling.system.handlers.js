'use strict'

const {
  COOLING_SYSTEM_PROJECTIONS,
  LOG_KEYS,
  WORKER_TYPES,
  WORKER_TAGS,
  EXPLORER_RACK_AGGR_FIELDS
} = require('../../constants')
const {
  isCentralDCSEnabled,
  getDCSTag,
  extractDcsThing,
  getSensorReading,
  sensorReading
} = require('../../dcs.utils')
const { aggregateRackStats } = require('./explorer.handlers')

/**
 * BE-9 — Layout positional / equipment-id contract (FE binds by position or id):
 *  - circuit1.lines[0] = Line 1 / Groups 1-8, lines[1] = Line 2 / Groups 9-16.
 *  - pumps[] keep config order: pumps[0/1/2] = A/B/C per circuit.
 *  - Cooling towers are matched by `id` (TR-7501 miner loop, TR-7502 HVAC condenser).
 *  - Control valves / sensors are resolved by their config tag against the single
 *    flat `equipment.*` arrays, so every equipment `.equipment` id MUST stay
 *    GLOBALLY UNIQUE. Two entries sharing an id make `find()` ambiguous and cannot
 *    be disambiguated by circuit — keep ids unique at the source (DCS config).
 *  Do not reorder or reshape these arrays.
 *
 * BE-1 deferred renames (kept unique pending controls/DCS provisioning of a
 * globally-unique tag — applying them verbatim would duplicate an existing id):
 *  - PCV-7503 -> PCV-7501 (collides with HVAC pressure_bypass PCV-7501).
 *  - LIT-7504 -> LT-7591  (collides with HVAC buffer-tank LT-7591).
 */
function getFieldProjection (type, view) {
  const base = COOLING_SYSTEM_PROJECTIONS.base
  const typeProjections = COOLING_SYSTEM_PROJECTIONS[type]
  const viewProjection = typeProjections?.[view] || {}
  return { ...base, ...viewProjection }
}

function filterPumpsByCircuit (pumps, circuit) {
  return (pumps || []).filter(p => p.circuit === circuit)
}

function formatPump (pump) {
  return {
    id: pump.equipment,
    name: pump.equipment,
    label: pump.label,
    status: pump.status,
    is_running: pump.fbk_run_out || false,
    speed: pump.speed,
    current: pump.current,
    has_fault: pump.trip || false,
    has_interlock: pump.intlock || false
  }
}

function getSensorWithTag (sensors, sensorId, defaultConfig) {
  if (!sensorId) return null
  const sensor = sensors?.find(s => s.equipment === sensorId)
  return {
    tag: sensorId,
    type: sensor?.type || null,
    // Keep the unit and surface value: null when a configured sensor is
    // present but its tag isn't readable; fall back only when absent entirely.
    reading: sensor
      ? { value: sensor.value ?? null, unit: sensor.unit ?? null }
      : (defaultConfig || null)
  }
}

function buildVibrationSwitch (vibrationSwitches, switchTag) {
  if (!switchTag) return null
  const sw = (vibrationSwitches || []).find(s => s.equipment === switchTag)
  return { tag: switchTag, state: sw?.state ?? null }
}

function buildGroupDifferentialPressure (lineConfig, pressures) {
  const groupSensors = lineConfig.group_pressure_sensors || {}

  if (Array.isArray(groupSensors)) {
    return groupSensors.map((sensorId, i) => {
      const pt = pressures?.find(s => s.equipment === sensorId) || null
      const mkSlot = (val) => ({
        tag: sensorId,
        type: pt?.type || null,
        reading: val != null ? { value: val, unit: pt?.unit || 'bar' } : null
      })
      const supply = mkSlot(pt?.supply_pressure)
      const ret = mkSlot(pt?.return_pressure)
      const supplyVal = supply.reading?.value
      const returnVal = ret.reading?.value
      const deltaPVal = pt?.differential_pressure != null
        ? Math.round(pt.differential_pressure * 100) / 100
        : (supplyVal != null && returnVal != null
            ? Math.round((supplyVal - returnVal) * 100) / 100
            : null)
      const unit = supply.reading?.unit || ret.reading?.unit || pt?.unit || 'bar'
      return {
        group: i + 1,
        supply,
        return: ret,
        delta_p: deltaPVal != null ? { value: deltaPVal, unit } : null
      }
    })
  }

  const supplyIds = groupSensors.supply || []
  const returnIds = groupSensors.return || []
  const count = Math.max(supplyIds.length, returnIds.length)

  const rows = []
  for (let i = 0; i < count; i++) {
    const supply = getSensorWithTag(pressures, supplyIds[i])
    const ret = getSensorWithTag(pressures, returnIds[i])
    const supplyVal = supply?.reading?.value
    const returnVal = ret?.reading?.value
    const deltaPVal = (supplyVal != null && returnVal != null)
      ? Math.round((supplyVal - returnVal) * 100) / 100
      : null
    const unit = supply?.reading?.unit || ret?.reading?.unit || 'bar'
    rows.push({
      group: i + 1,
      supply,
      return: ret,
      delta_p: deltaPVal != null ? { value: deltaPVal, unit } : null
    })
  }
  return rows
}

function buildMinersCircuit1View (equipment, config) {
  const pumps = equipment.pumps
  const temperatures = equipment.temperatures
  const pressures = equipment.pressures
  const flows = equipment.flows
  const heatExchangers = equipment.heat_exchangers
  const valves = equipment.valves
  const coolingConfig = config?.cooling_system?.miner_loop || {}
  const viewConfig = config?.cooling_system?.view_metadata?.miners?.circuit1 || {}

  const findHx = (hxId) => (heatExchangers || []).find(hx => hx.equipment === hxId)

  const hxConfigs = coolingConfig.heat_exchangers || {}

  const lines = []
  const lineConfigs = [coolingConfig.line1, coolingConfig.line2].filter(Boolean)

  for (const lineConfig of lineConfigs) {
    const hx = findHx(lineConfig.heat_exchanger)
    const hxConfigKey = lineConfig.heat_exchanger?.toLowerCase()
    const hxSensorConfig = hxConfigs[hxConfigKey] || {}

    const supplyTempSensor = getSensorWithTag(temperatures, lineConfig.supply_temp_sensor, coolingConfig.defaults?.supply_temp)
    const supplyPressureSensor = getSensorWithTag(pressures, lineConfig.supply_pressure_sensor)
    const supplyFlowSensor = getSensorWithTag(flows, lineConfig.supply_flow_sensor)
    const returnTempSensor = getSensorWithTag(temperatures, lineConfig.return_temp_sensor, coolingConfig.defaults?.return_temp)
    const returnPressureSensor = getSensorWithTag(pressures, lineConfig.return_pressure_sensor)

    const minerSideOutSensorId = hxSensorConfig.miner_side_out_sensor
    const minerSideOutSensor = getSensorWithTag(temperatures, minerSideOutSensorId)
    if (minerSideOutSensor) {
      minerSideOutSensor.role = 'post_hx'
      minerSideOutSensor.target = coolingConfig.defaults?.supply_temp || null
    }

    const controlValveId = lineConfig.control_valve
    const controlValve = valves?.find(v => v.equipment === controlValveId)

    lines.push({
      name: lineConfig.name,
      groups: lineConfig.groups,
      supply: {
        temperature: supplyTempSensor?.reading || getSensorReading(temperatures, lineConfig.supply_temp_sensor, coolingConfig.defaults?.supply_temp),
        pressure: getSensorReading(pressures, lineConfig.supply_pressure_sensor),
        flow: getSensorReading(flows, lineConfig.supply_flow_sensor),
        sensors: [supplyTempSensor, supplyPressureSensor, supplyFlowSensor].filter(Boolean)
      },
      return: {
        temperature: getSensorReading(temperatures, lineConfig.return_temp_sensor, coolingConfig.defaults?.return_temp),
        pressure: getSensorReading(pressures, lineConfig.return_pressure_sensor),
        sensors: [returnTempSensor, returnPressureSensor].filter(Boolean)
      },
      differential_pressure: buildGroupDifferentialPressure(lineConfig, pressures),
      heat_exchanger: hx
        ? {
            id: hx.equipment,
            name: hx.equipment,
            is_active: hx.is_active,
            miner_side_out_temp: hx.miner_side_out_temp,
            tower_side_in_temp: hx.tower_side_in_temp,
            tower_side_out_temp: hx.tower_side_out_temp,
            sensors: [
              minerSideOutSensor,
              controlValve
                ? {
                    tag: controlValveId,
                    type: controlValve.type || controlValve.description,
                    reading: controlValve.position || hx.tcv_position
                  }
                : null
            ].filter(Boolean),
            control_valve: {
              id: hx.tcv_id || controlValveId,
              position: controlValve?.position || hx.tcv_position
            }
          }
        : null
    })
  }

  // Compute summary values from line sensor data — units derived from sensors
  const tempUnit = lines[0]?.supply?.temperature?.unit
  const flowUnit = lines[0]?.supply?.flow?.unit
  // avg over the 16 per-group PTs, not the unset per-line pressure sensors
  const allGroups = lines.flatMap(l => l.differential_pressure || [])
  const pressureUnit = allGroups.find(g => g.supply?.reading?.unit)?.supply?.reading?.unit ||
    allGroups.find(g => g.return?.reading?.unit)?.return?.reading?.unit ||
    lines[0]?.supply?.pressure?.unit

  const allSupplyTemps = lines.map(l => l.supply.temperature?.value).filter(v => v != null)
  const allReturnTemps = lines.map(l => l.return.temperature?.value).filter(v => v != null)
  const allSupplyFlows = lines.map(l => l.supply.flow?.value).filter(v => v != null)
  const groupSupplyPressures = allGroups.map(g => g.supply?.reading?.value).filter(v => v != null)
  const groupReturnPressures = allGroups.map(g => g.return?.reading?.value).filter(v => v != null)
  const allGroupDeltaP = allGroups.map(g => g.delta_p?.value).filter(v => v != null)
  // prefer per-group PTs; fall back to line-level pressure
  const allSupplyPressures = groupSupplyPressures.length > 0
    ? groupSupplyPressures
    : lines.map(l => l.supply.pressure?.value).filter(v => v != null)
  const allReturnPressures = groupReturnPressures.length > 0
    ? groupReturnPressures
    : lines.map(l => l.return.pressure?.value).filter(v => v != null)

  const avgSupplyTemp = allSupplyTemps.length > 0
    ? Math.round((allSupplyTemps.reduce((a, b) => a + b, 0) / allSupplyTemps.length) * 10) / 10
    : null
  const avgReturnTemp = allReturnTemps.length > 0
    ? Math.round((allReturnTemps.reduce((a, b) => a + b, 0) / allReturnTemps.length) * 10) / 10
    : null
  const totalFlow = allSupplyFlows.length > 0
    ? Math.round(allSupplyFlows.reduce((a, b) => a + b, 0) * 10) / 10
    : null
  const systemPressure = allSupplyPressures.length > 0
    ? Math.round((allSupplyPressures.reduce((a, b) => a + b, 0) / allSupplyPressures.length) * 10) / 10
    : null
  const deltaT = (avgSupplyTemp != null && avgReturnTemp != null)
    ? Math.round((avgReturnTemp - avgSupplyTemp) * 10) / 10
    : null

  const inletPressureAvg = allSupplyPressures.length > 0
    ? Math.round((allSupplyPressures.reduce((a, b) => a + b, 0) / allSupplyPressures.length) * 100) / 100
    : null
  const outletPressureAvg = allReturnPressures.length > 0
    ? Math.round((allReturnPressures.reduce((a, b) => a + b, 0) / allReturnPressures.length) * 100) / 100
    : null
  const deltaPAvg = allGroupDeltaP.length > 0
    ? Math.round((allGroupDeltaP.reduce((a, b) => a + b, 0) / allGroupDeltaP.length) * 100) / 100
    : ((inletPressureAvg != null && outletPressureAvg != null)
        ? Math.round((inletPressureAvg - outletPressureAvg) * 100) / 100
        : null)

  const controlValveEntries = coolingConfig.control_valves || {}
  const controlValves = {}
  for (const [role, valveId] of Object.entries(controlValveEntries)) {
    const valve = valves?.find(v => v.equipment === valveId)
    controlValves[role] = {
      id: valveId,
      type: valve?.type || null,
      description: valve?.description || null,
      position: valve?.position || null,
      setpoint: valve?.setpoint || null
    }
  }

  const formattedPumps = filterPumpsByCircuit(pumps, 'MINER_LOOP').map(formatPump)

  return {
    title: coolingConfig.name || viewConfig.title,
    description: coolingConfig.description || viewConfig.description,
    water_type: coolingConfig.water_type || viewConfig.water_type,
    target_supply_temp: coolingConfig.defaults?.supply_temp,
    target_return_temp: coolingConfig.defaults?.return_temp,
    summary: {
      supply_temp: avgSupplyTemp != null ? { value: avgSupplyTemp, unit: tempUnit } : null,
      return_temp: avgReturnTemp != null ? { value: avgReturnTemp, unit: tempUnit } : null,
      delta_t: deltaT != null ? { value: deltaT, unit: tempUnit } : null,
      total_flow: totalFlow != null ? { value: totalFlow, unit: flowUnit } : null,
      rated_flow: coolingConfig.defaults?.rated_flow || null,
      system_pressure: systemPressure != null ? { value: systemPressure, unit: pressureUnit } : null,
      inlet_pressure_avg: inletPressureAvg != null ? { value: inletPressureAvg, unit: pressureUnit } : null,
      outlet_pressure_avg: outletPressureAvg != null ? { value: outletPressureAvg, unit: pressureUnit } : null,
      delta_p_avg: deltaPAvg != null ? { value: deltaPAvg, unit: pressureUnit } : null
    },
    pumps_config: coolingConfig.defaults?.pumps_config || null,
    lines,
    control_valves: Object.keys(controlValves).length > 0 ? controlValves : null,
    pumps: formattedPumps
  }
}

function buildMinersCircuit2View (equipment, config) {
  const pumps = equipment.pumps
  const temperatures = equipment.temperatures
  const levels = equipment.levels
  const heatExchangers = equipment.heat_exchangers
  const coolingTowers = (equipment.cooling_towers || []).filter(ct => ct.circuit === 'COOLING_TOWER')
  const vibrationSwitches = equipment.vibration_switches
  const valves = equipment.valves
  const tanks = equipment.tanks
  const towerConfig = config?.cooling_system?.cooling_tower_loop || {}
  const minerLoopConfig = config?.cooling_system?.miner_loop || {}
  const makeupGlobalConfig = config?.cooling_system?.makeup || {}
  const viewConfig = config?.cooling_system?.view_metadata?.miners?.circuit2 || {}

  // Build HX → groups mapping from miner_loop line configs
  const hxGroupsMap = {}
  const lineConfigs = [minerLoopConfig.line1, minerLoopConfig.line2].filter(Boolean)
  for (const lineConfig of lineConfigs) {
    if (lineConfig.heat_exchanger) {
      hxGroupsMap[lineConfig.heat_exchanger] = lineConfig.groups
    }
  }

  // Heat exchangers with full sensor detail
  const hxConfigs = towerConfig.heat_exchangers || {}
  const targetSupplyTemp = minerLoopConfig.defaults?.supply_temp || null
  const heatExchangerData = (heatExchangers || []).map(hx => {
    const hxConfigKey = hx.equipment?.toLowerCase()
    const hxSensorConfig = hxConfigs[hxConfigKey] || {}
    const controlValveId = minerLoopConfig.heat_exchangers?.[hxConfigKey]?.control_valve ||
                           minerLoopConfig.heat_exchangers?.[hx.equipment]?.control_valve
    const controlValve = controlValveId ? valves?.find(v => v.equipment === controlValveId) : null

    const minerSideOutSensor = getSensorWithTag(temperatures, hxSensorConfig.miner_side_out_sensor)
    if (minerSideOutSensor) {
      minerSideOutSensor.role = 'post_hx'
      minerSideOutSensor.target = targetSupplyTemp
    }
    const towerSideInSensor = getSensorWithTag(temperatures, hxSensorConfig.tower_side_in_sensor)
    if (towerSideInSensor) towerSideInSensor.role = 'tower_side_in'
    const towerSideOutSensor = getSensorWithTag(temperatures, hxSensorConfig.tower_side_out_sensor)
    if (towerSideOutSensor) towerSideOutSensor.role = 'tower_side_out'

    return {
      id: hx.equipment,
      name: hx.equipment,
      groups: hxGroupsMap[hx.equipment] || null,
      is_active: hx.is_active,
      miner_side_out_temp: hx.miner_side_out_temp,
      tower_side_in_temp: hx.tower_side_in_temp,
      tower_side_out_temp: hx.tower_side_out_temp,
      sensors: [
        controlValve
          ? { tag: controlValveId, type: controlValve.type, reading: controlValve.position || hx.tcv_position }
          : null,
        minerSideOutSensor,
        towerSideInSensor,
        towerSideOutSensor
      ].filter(Boolean),
      control_valve: controlValveId
        ? { id: controlValveId, position: controlValve?.position || hx.tcv_position }
        : null
    }
  })

  // pre/post-HX from the loop's configured sensors, else HX-derived
  const preHxConfigReading = getSensorReading(temperatures, towerConfig.pre_hx_temp_sensor)
  const postHxConfigReading = getSensorReading(temperatures, towerConfig.post_hx_temp_sensor)

  const allTowerSideIn = heatExchangerData.map(hx => hx.tower_side_in_temp?.value).filter(v => v != null)
  const allTowerSideOut = heatExchangerData.map(hx => hx.tower_side_out_temp?.value).filter(v => v != null)
  const hxPreHxTemp = allTowerSideIn.length > 0
    ? Math.round((allTowerSideIn.reduce((a, b) => a + b, 0) / allTowerSideIn.length) * 10) / 10
    : null
  const hxPostHxTemp = allTowerSideOut.length > 0
    ? Math.round((allTowerSideOut.reduce((a, b) => a + b, 0) / allTowerSideOut.length) * 10) / 10
    : null
  const preHxTemp = preHxConfigReading?.value ?? hxPreHxTemp
  const postHxTemp = postHxConfigReading?.value ?? hxPostHxTemp
  const deltaT = (preHxTemp != null && postHxTemp != null)
    ? Math.round((postHxTemp - preHxTemp) * 10) / 10
    : null
  const tempUnit = preHxConfigReading?.unit || postHxConfigReading?.unit || heatExchangerData[0]?.tower_side_in_temp?.unit

  // Tower level from config sensor
  const towerLevelSensor = towerConfig.tower_level_sensor

  // Cooling towers with sensor tag references
  const towerFanId = towerConfig.tower_fan
  const towerVibrationSwitch = buildVibrationSwitch(vibrationSwitches, towerConfig.tower_vibration_switch)

  const towerData = (coolingTowers || []).map(ct => ({
    id: ct.equipment,
    name: ct.equipment,
    is_running: ct.is_running,
    fan_status: ct.fan_status,
    fan_speed: ct.fan_speed,
    fan_cv: ct.fan_cv,
    fan_id: towerFanId,
    level: ct.level,
    level_sensor: towerLevelSensor,
    vibration_switch: towerVibrationSwitch,
    capacity_flow: towerConfig.defaults?.tower_capacity || null,
    capacity_gcal: towerConfig.defaults?.tower_capacity_gcal || null
  }))

  // Makeup water system
  const makeupConfig = towerConfig.makeup || {}
  const makeupTankId = makeupConfig.tank || tanks?.[0]?.equipment
  const makeupLevelValve = valves?.find(v => v.equipment === makeupConfig.level_control_valve)
  const makeupOnOffValves = makeupConfig.on_off_valves || []
  const makeupPumpId = makeupGlobalConfig.pump || null
  const makeupPump = makeupPumpId ? (pumps || []).find(p => p.equipment === makeupPumpId) : null

  const makeupSystem = {
    tank: {
      id: makeupTankId,
      name: makeupTankId,
      volume: makeupGlobalConfig.defaults?.tank_volume || null,
      level: getSensorReading(levels, makeupConfig.level_sensor),
      level_sensor: makeupConfig.level_sensor
    },
    pump: makeupPumpId
      ? {
          id: makeupPumpId,
          name: makeupPumpId,
          status: makeupPump?.status ?? null,
          is_running: makeupPump?.fbk_run_out || false,
          speed: makeupPump?.speed ?? null,
          current: makeupPump?.current ?? null,
          rated_head: makeupGlobalConfig.defaults?.pump_head || null,
          rated_flow: makeupGlobalConfig.defaults?.pump_flow || null
        }
      : null,
    level_control_valve: makeupConfig.level_control_valve
      ? {
          id: makeupConfig.level_control_valve,
          type: makeupLevelValve?.type || null,
          description: makeupLevelValve?.description || null,
          position: makeupLevelValve?.position
        }
      : null,
    on_off_valves: makeupOnOffValves.map(vid => {
      const valve = valves?.find(v => v.equipment === vid)
      return {
        id: vid,
        type: valve?.type || null,
        position: valve?.position,
        is_open: valve?.position?.value > 50
      }
    })
  }

  const towerPumps = filterPumpsByCircuit(pumps, 'COOLING_TOWER').map(formatPump)

  return {
    title: towerConfig.name || viewConfig.title,
    description: towerConfig.description || viewConfig.description,
    water_type: towerConfig.water_type || viewConfig.water_type,
    summary: {
      pre_hx_temp: towerConfig.pre_hx_temp_sensor
        ? { value: preHxTemp ?? null, unit: tempUnit || '°C', sensor: towerConfig.pre_hx_temp_sensor }
        : (preHxTemp != null ? { value: preHxTemp, unit: tempUnit } : null),
      post_hx_temp: towerConfig.post_hx_temp_sensor
        ? { value: postHxTemp ?? null, unit: tempUnit || '°C', sensor: towerConfig.post_hx_temp_sensor }
        : (postHxTemp != null ? { value: postHxTemp, unit: tempUnit } : null),
      delta_t: deltaT != null ? { value: deltaT, unit: tempUnit } : null,
      tower_capacity: towerConfig.defaults?.tower_capacity || null,
      tower_capacity_gcal: towerConfig.defaults?.tower_capacity_gcal || null,
      tower_level: sensorReading(levels, towerLevelSensor, '%')
    },
    pumps_config: towerConfig.defaults?.pumps_config || null,
    heat_exchangers: heatExchangerData,
    cooling_towers: towerData,
    makeup: makeupSystem,
    pumps: towerPumps
  }
}

function buildMinersLayoutView (equipment, config, stats, rackPowerByRack) {
  const circuit1 = buildMinersCircuit1View(equipment, config)
  const circuit2 = buildMinersCircuit2View(equipment, config)
  const { pumps } = equipment
  const flowStats = stats?.flow || {}
  const miningConfig = config?.mining || {}
  const viewConfig = config?.cooling_system?.view_metadata?.miners?.layout || {}

  // Mining room groups grid
  const totalGroups = miningConfig.total_groups || 16
  const racksPerGroup = miningConfig.racks_per_group || 4
  const minersPerRack = miningConfig.miners_per_rack || 20
  const vlanStart = miningConfig.vlan_start || 129
  const totalMiners = totalGroups * racksPerGroup * minersPerRack

  const groups = []
  for (let i = 1; i <= totalGroups; i++) {
    const group = {
      id: `G${i}`,
      name: `G${i}`,
      vlan: vlanStart + (i - 1)
    }
    if (rackPowerByRack) {
      const statuses = []
      for (let r = 1; r <= racksPerGroup; r++) {
        const powerW = rackPowerByRack[`group-${i}_rack-${r}`]
        statuses.push(powerW != null && powerW > 0)
      }
      group.rack_statuses = statuses
    }
    groups.push(group)
  }

  return {
    title: viewConfig.title,
    description: viewConfig.description,
    summary: {
      total_miner_loop_flow: flowStats.miner_loop,
      total_tower_loop_flow: flowStats.cooling_tower,
      pumps_running: (pumps || []).filter(p => p.fbk_run_out).length,
      pumps_total: (pumps || []).length
    },
    legend: {
      c1_supply_temp: circuit1.summary?.supply_temp,
      c1_return_temp: circuit1.summary?.return_temp,
      c2_tower_cold: circuit2.summary?.pre_hx_temp,
      c2_tower_hot: circuit2.summary?.post_hx_temp
    },
    mining_room: {
      total_groups: totalGroups,
      racks_per_group: racksPerGroup,
      miners_per_rack: minersPerRack,
      total_miners: totalMiners,
      miner_model: miningConfig.miner_model || null,
      groups
    },
    circuit1: {
      name: circuit1.title,
      water_type: circuit1.water_type,
      summary: circuit1.summary,
      pumps_config: circuit1.pumps_config,
      lines: circuit1.lines,
      control_valves: circuit1.control_valves,
      pumps: circuit1.pumps
    },
    circuit2: {
      name: circuit2.title,
      water_type: circuit2.water_type,
      summary: circuit2.summary,
      pumps_config: circuit2.pumps_config,
      heat_exchangers: circuit2.heat_exchangers,
      cooling_towers: circuit2.cooling_towers,
      makeup: circuit2.makeup,
      pumps: circuit2.pumps
    }
  }
}

function buildHvacCircuit1View (equipment, config) {
  const pumps = equipment.pumps
  const temperatures = equipment.temperatures
  const pressures = equipment.pressures
  const flows = equipment.flows
  const levels = equipment.levels
  const chillers = equipment.chillers
  const fanCoils = equipment.fan_coils
  const valves = equipment.valves
  const tanks = equipment.tanks
  const fans = equipment.fans
  const flowSwitches = equipment.flow_switches
  const chilledConfig = config?.cooling_system?.hvac_chilled_water || {}
  const viewConfig = config?.cooling_system?.view_metadata?.hvac?.circuit1 || {}

  const supplyReturnConfig = chilledConfig.supply_return || {}
  const condenserConfig = chilledConfig.condenser || {}

  const chiller = chillers?.[0]
  const chillerData = chiller
    ? {
        id: chiller.equipment,
        name: chiller.equipment,
        is_running: chiller.is_running,
        mode: chiller.mode,
        capacity_tr: chilledConfig.chiller_capacity_tr || null,
        cooling_capacity: chiller.cooling_capacity,
        compressor_load: chiller.compressor_load,
        power_consumption: chiller.power_consumption,
        evaporator_temp: chiller.evaporator_temp,
        condenser_temp: chiller.condenser_temp,
        chilled_water_side: {
          inlet_temp: getSensorWithTag(temperatures, supplyReturnConfig.return_temp_sensor),
          outlet_temp: getSensorWithTag(temperatures, supplyReturnConfig.supply_temp_sensor),
          inlet_flow: getSensorWithTag(flows, supplyReturnConfig.return_flow_sensor),
          outlet_flow: getSensorWithTag(flows, supplyReturnConfig.supply_flow_sensor),
          flow_switch: supplyReturnConfig.flow_switches?.[0]
            ? { tag: supplyReturnConfig.flow_switches[0], is_active: (flowSwitches || []).find(fs => fs.equipment === supplyReturnConfig.flow_switches[0])?.is_active }
            : null
        },
        condenser_water_side: {
          inlet_temp: getSensorWithTag(temperatures, condenserConfig.inlet_temp_sensor),
          outlet_temp: getSensorWithTag(temperatures, condenserConfig.outlet_temp_sensor),
          inlet_flow: getSensorWithTag(flows, condenserConfig.inlet_flow_sensor),
          outlet_flow: getSensorWithTag(flows, condenserConfig.outlet_flow_sensor),
          flow_switch: supplyReturnConfig.flow_switches?.[1]
            ? { tag: supplyReturnConfig.flow_switches[1], is_active: (flowSwitches || []).find(fs => fs.equipment === supplyReturnConfig.flow_switches[1])?.is_active }
            : null
        }
      }
    : null

  const supplyTemp = getSensorReading(temperatures, supplyReturnConfig.supply_temp_sensor, chilledConfig.defaults?.supply_temp)
  const returnTemp = getSensorReading(temperatures, supplyReturnConfig.return_temp_sensor, chilledConfig.defaults?.return_temp)
  const supplyFlow = getSensorReading(flows, supplyReturnConfig.supply_flow_sensor)
  const returnFlow = getSensorReading(flows, supplyReturnConfig.return_flow_sensor)
  const systemPressure = getSensorReading(pressures, supplyReturnConfig.pressure_sensor)

  const supplyReturn = {
    supply: {
      temperature: supplyTemp,
      flow: supplyFlow,
      pressure: systemPressure
    },
    return: {
      temperature: returnTemp,
      flow: returnFlow
    },
    flow_switches: (supplyReturnConfig.flow_switches || []).map(fsId => {
      const fs = (flowSwitches || []).find(f => f.equipment === fsId)
      return { id: fsId, is_active: fs?.is_active || false }
    })
  }

  const condenser = {
    inlet: {
      temperature: getSensorReading(temperatures, condenserConfig.inlet_temp_sensor),
      flow: getSensorReading(flows, condenserConfig.inlet_flow_sensor)
    },
    outlet: {
      temperature: getSensorReading(temperatures, condenserConfig.outlet_temp_sensor),
      flow: getSensorReading(flows, condenserConfig.outlet_flow_sensor)
    }
  }

  const tempUnit = supplyTemp?.unit
  const flowUnit = supplyFlow?.unit
  const avgSupplyTemp = supplyTemp?.value
  const avgReturnTemp = returnTemp?.value
  const totalFlow = supplyFlow?.value
  const deltaT = (avgSupplyTemp != null && avgReturnTemp != null)
    ? Math.round((avgReturnTemp - avgSupplyTemp) * 10) / 10
    : null

  const bufferConfig = chilledConfig.buffer_tank || {}
  const bufferTankId = bufferConfig.tank || tanks?.[0]?.equipment
  const makeupValve = valves?.find(v => v.equipment === bufferConfig.makeup_valve)
  const bufferTank = {
    id: bufferTankId,
    name: bufferTankId,
    volume: chilledConfig.defaults?.buffer_tank_volume || null,
    level: getSensorReading(levels, bufferConfig.level_sensor),
    level_sensor: bufferConfig.level_sensor,
    makeup_valve: bufferConfig.makeup_valve
      ? {
          id: bufferConfig.makeup_valve,
          type: makeupValve?.type || null,
          description: makeupValve?.description || null,
          position: makeupValve?.position,
          is_open: makeupValve?.position?.value > 50
        }
      : null
  }

  const controlValveEntries = chilledConfig.control_valves || {}
  const controlValves = {}
  for (const [role, valveId] of Object.entries(controlValveEntries)) {
    const valve = valves?.find(v => v.equipment === valveId)
    controlValves[role] = {
      id: valveId,
      type: valve?.type || null,
      description: valve?.description || null,
      position: valve?.position || null,
      setpoint: valve?.setpoint || null,
      controlled_by: supplyReturnConfig.pressure_sensor || null
    }
  }

  if (controlValves.pressure_bypass) {
    controlValves.pressure_bypass.pressure = systemPressure
      ? { tag: supplyReturnConfig.pressure_sensor || null, value: systemPressure.value, unit: systemPressure.unit }
      : null
  }

  const returnPumps = filterPumpsByCircuit(pumps, 'HVAC_RETURN').map(formatPump)
  const supplyPumps = filterPumpsByCircuit(pumps, 'HVAC_SUPPLY').map(formatPump)

  const fanCoilTagMap = {}
  for (const fcCfg of (chilledConfig.fan_coils || [])) {
    if (fcCfg.id) fanCoilTagMap[fcCfg.id] = fcCfg
  }

  const fanCoilsSummary = {
    total: (fanCoils || []).length,
    running: (fanCoils || []).filter(fc => fc.is_running).length,
    units: (fanCoils || []).map(fc => {
      const fcMeta = fanCoilTagMap[fc.equipment] || {}
      const valveTag = fcMeta.valve_tag || null
      const temperatureTag = fcMeta.temperature_tag || null
      const fcNumber = fc.equipment.replace(/^FCT?-/, '')
      const fanId = `V-${fcNumber}`
      const fan = (fans || []).find(f => f.equipment === fanId)
      const valve = valveTag ? valves?.find(v => v.equipment === valveTag) : null

      return {
        id: fc.equipment,
        is_running: fc.is_running,
        fan_id: fanId,
        fan_running: fan?.fbk_run_out || false,
        fan_speed: fc.fan_speed,
        valve_tag: valveTag,
        valve_position: valve?.position || fc.valve_position,
        temperature_tag: temperatureTag,
        temperature: fc.temperature
      }
    })
  }

  return {
    title: chilledConfig.name || viewConfig.title,
    description: chilledConfig.description || viewConfig.description,
    target_supply_temp: chilledConfig.defaults?.supply_temp,
    target_return_temp: chilledConfig.defaults?.return_temp,
    summary: {
      supply_temp: avgSupplyTemp != null ? { value: avgSupplyTemp, unit: tempUnit } : null,
      return_temp: avgReturnTemp != null ? { value: avgReturnTemp, unit: tempUnit } : null,
      delta_t: deltaT != null ? { value: deltaT, unit: tempUnit } : null,
      total_flow: totalFlow != null ? { value: totalFlow, unit: flowUnit } : null,
      rated_flow: chilledConfig.defaults?.rated_flow || null,
      system_pressure: sensorReading(pressures, supplyReturnConfig.pressure_sensor, 'bar')
    },
    chiller: chillerData,
    supply_return: supplyReturn,
    condenser,
    buffer_tank: bufferTank,
    control_valves: Object.keys(controlValves).length > 0 ? controlValves : null,
    return_pumps_config: chilledConfig.defaults?.return_pumps_config || null,
    supply_pumps_config: chilledConfig.defaults?.supply_pumps_config || null,
    return_pumps: returnPumps,
    supply_pumps: supplyPumps,
    fan_coils: fanCoilsSummary
  }
}

function buildHvacCircuit2View (equipment, config) {
  const pumps = equipment.pumps
  const temperatures = equipment.temperatures
  const flows = equipment.flows
  const levels = equipment.levels
  const coolingTowers = (equipment.cooling_towers || []).filter(ct => ct.circuit === 'HVAC_CONDENSER')
  const condenserConfig = config?.cooling_system?.hvac_condenser || {}
  const viewConfig = config?.cooling_system?.view_metadata?.hvac?.circuit2 || {}

  const supplyReturnConfig = condenserConfig.supply_return || {}

  const supplyTemp = getSensorReading(temperatures, supplyReturnConfig.supply_temp_sensor, condenserConfig.defaults?.supply_temp)
  const returnTemp = getSensorReading(temperatures, supplyReturnConfig.return_temp_sensor, condenserConfig.defaults?.return_temp)
  const supplyFlow = getSensorReading(flows, supplyReturnConfig.supply_flow_sensor)
  const returnFlow = getSensorReading(flows, supplyReturnConfig.return_flow_sensor)

  const supplyTempSensor = getSensorWithTag(temperatures, supplyReturnConfig.supply_temp_sensor)
  const supplyFlowSensor = getSensorWithTag(flows, supplyReturnConfig.supply_flow_sensor)
  const returnTempSensor = getSensorWithTag(temperatures, supplyReturnConfig.return_temp_sensor)
  const returnFlowSensor = getSensorWithTag(flows, supplyReturnConfig.return_flow_sensor)

  const supplyReturn = {
    supply: {
      name: 'Supply To Tower',
      temperature: supplyTemp,
      flow: supplyFlow,
      sensors: [supplyTempSensor, supplyFlowSensor].filter(Boolean)
    },
    return: {
      name: 'Return From Tower',
      temperature: returnTemp,
      flow: returnFlow,
      sensors: [returnTempSensor, returnFlowSensor].filter(Boolean)
    }
  }

  const tempUnit = supplyTemp?.unit
  const flowUnit = supplyFlow?.unit
  const totalFlow = supplyFlow?.value != null && returnFlow?.value != null
    ? Math.round(((supplyFlow.value + returnFlow.value) / 2) * 10) / 10
    : (supplyFlow?.value || returnFlow?.value || null)
  const deltaT = (supplyTemp?.value != null && returnTemp?.value != null)
    ? Math.round((returnTemp.value - supplyTemp.value) * 10) / 10
    : null

  const towerConfigRef = condenserConfig.tower || {}
  const towerLevelSensorId = towerConfigRef.level_sensor
  const towerFanId = towerConfigRef.fan
  const towerVibrationSwitch = buildVibrationSwitch(equipment.vibration_switches, towerConfigRef.vibration_switch)

  const towerData = (coolingTowers || []).map(ct => ({
    id: ct.equipment,
    name: ct.equipment,
    is_running: ct.is_running,
    fan_status: ct.fan_status,
    fan_speed: ct.fan_speed,
    fan_cv: ct.fan_cv,
    fan_id: towerFanId || null,
    level: ct.level,
    level_sensor: towerLevelSensorId || null,
    vibration_switch: towerVibrationSwitch,
    capacity_mcal: condenserConfig.defaults?.tower_capacity_mcal || null,
    capacity_flow: condenserConfig.defaults?.tower_flow || null
  }))

  const condenserPumps = filterPumpsByCircuit(pumps, 'HVAC_CONDENSER').map(formatPump)

  return {
    title: condenserConfig.name || viewConfig.title,
    description: condenserConfig.description || viewConfig.description,
    target_supply_temp: condenserConfig.defaults?.supply_temp,
    target_return_temp: condenserConfig.defaults?.return_temp,
    summary: {
      supply_temp: supplyTemp,
      return_temp: returnTemp,
      delta_t: deltaT != null ? { value: deltaT, unit: tempUnit } : null,
      total_flow: totalFlow != null ? { value: totalFlow, unit: flowUnit } : null,
      rated_flow: condenserConfig.defaults?.pumps_config?.rated_flow || null,
      tower_level: sensorReading(levels, towerLevelSensorId, '%')
    },
    pumps_config: condenserConfig.defaults?.pumps_config || null,
    supply_return: supplyReturn,
    cooling_towers: towerData,
    pumps: condenserPumps
  }
}

function buildHvacLayoutView (equipment, config) {
  const circuit1 = buildHvacCircuit1View(equipment, config)
  const circuit2 = buildHvacCircuit2View(equipment, config)
  const { pumps } = equipment
  const viewConfig = config?.cooling_system?.view_metadata?.hvac?.layout || {}

  return {
    title: viewConfig.title,
    description: viewConfig.description,
    summary: {
      chiller_running: circuit1.chiller?.is_running || false,
      fan_coils_running: circuit1.fan_coils.running,
      fan_coils_total: circuit1.fan_coils.total,
      cooling_towers_running: circuit2.cooling_towers.filter(ct => ct.is_running).length,
      pumps_running: (pumps || []).filter(p => p.fbk_run_out).length,
      pumps_total: (pumps || []).length
    },
    legend: {
      c1_supply_temp: circuit1.summary?.supply_temp,
      c1_return_temp: circuit1.summary?.return_temp,
      c2_condenser_cold: circuit2.target_supply_temp,
      c2_condenser_hot: circuit2.target_return_temp
    },
    circuit1: {
      name: circuit1.title,
      summary: circuit1.summary,
      chiller: circuit1.chiller,
      supply_return: circuit1.supply_return,
      condenser: circuit1.condenser,
      buffer_tank: circuit1.buffer_tank,
      control_valves: circuit1.control_valves,
      return_pumps_config: circuit1.return_pumps_config,
      supply_pumps_config: circuit1.supply_pumps_config,
      return_pumps: circuit1.return_pumps,
      supply_pumps: circuit1.supply_pumps,
      fan_coils: circuit1.fan_coils
    },
    circuit2: {
      name: circuit2.title,
      summary: circuit2.summary,
      pumps_config: circuit2.pumps_config,
      supply_return: circuit2.supply_return,
      cooling_towers: circuit2.cooling_towers,
      pumps: circuit2.pumps
    }
  }
}

function buildHvacAmbientView (equipment, config, stats) {
  const fanCoils = equipment.fan_coils
  const humiditySensors = equipment.humidity_sensors
  const ambientConfig = config?.cooling_system?.ambient || {}
  const viewConfig = config?.cooling_system?.view_metadata?.hvac?.ambient || {}
  const humidityStats = stats?.humidity || {}

  const rooms = ambientConfig.rooms || []

  const roomData = rooms.map(roomConfig => {
    const roomFanCoils = (fanCoils || [])
      .filter(fc => (roomConfig.fan_coils || []).includes(fc.equipment))
      .map(fc => ({
        id: fc.equipment,
        name: fc.equipment,
        is_running: fc.is_running,
        temperature: fc.temperature,
        valve_position: fc.valve_position
      }))

    const roomTemps = roomFanCoils
      .filter(fc => fc.temperature?.value != null && Number.isFinite(fc.temperature.value))
      .map(fc => fc.temperature.value)
    const avgTemp = roomTemps.length > 0
      ? Math.round((roomTemps.reduce((a, b) => a + b, 0) / roomTemps.length) * 10) / 10
      : null
    const tempUnit = roomFanCoils[0]?.temperature?.unit

    const roomHumidity = (humiditySensors || [])
      .filter(h => (roomConfig.humidity_sensors || []).includes(h.equipment))
      .map(h => ({
        id: h.equipment,
        humidity: { value: h.value, unit: h.unit }
      }))

    const humidityValues = roomHumidity.filter(h => h.humidity.value != null).map(h => h.humidity.value)
    const avgHumidity = humidityValues.length > 0
      ? Math.round((humidityValues.reduce((a, b) => a + b, 0) / humidityValues.length) * 10) / 10
      : null
    const humidityUnit = roomHumidity[0]?.humidity?.unit

    return {
      name: roomConfig.name,
      temperature: avgTemp != null ? { value: avgTemp, unit: tempUnit } : null,
      humidity: avgHumidity != null ? { value: avgHumidity, unit: humidityUnit } : null,
      fan_coils: roomFanCoils,
      humidity_sensors: roomHumidity
    }
  })

  const ambientSensorIds = ambientConfig.ambient_sensors || []
  const ambientSensors = (humiditySensors || [])
    .filter(h => ambientSensorIds.includes(h.equipment))
    .map(h => ({
      id: h.equipment,
      humidity: { value: h.value, unit: h.unit }
    }))

  const humidityUnit = humiditySensors?.[0]?.unit

  return {
    title: viewConfig.title,
    description: viewConfig.description,
    summary: {
      average_humidity: humidityStats.avg != null ? { value: humidityStats.avg, unit: humidityUnit } : null,
      rooms_count: roomData.length,
      fan_coils_running: (fanCoils || []).filter(fc => fc.is_running).length,
      fan_coils_total: (fanCoils || []).length
    },
    rooms: roomData,
    ambient_sensors: ambientSensors
  }
}

/**
 *
 * @param {Object} snap - Device snap data
 * @param {string} type - 'miners' or 'hvac'
 * @param {string} view - View name (circuit1, circuit2, layout, ambient)
 * @returns {Object|null}
 */
function buildCoolingViewData (snap, type, view, rackPowerByRack) {
  const equipment = snap.stats?.dcs_specific?.equipment || {}
  const config = snap.config || {}
  const stats = snap.stats || {}

  if (type === 'miners') {
    switch (view) {
      case 'circuit1':
        return buildMinersCircuit1View(equipment, config)
      case 'circuit2':
        return buildMinersCircuit2View(equipment, config)
      case 'layout':
        return buildMinersLayoutView(equipment, config, stats, rackPowerByRack)
      default:
        return null
    }
  }

  if (type === 'hvac') {
    switch (view) {
      case 'circuit1':
        return buildHvacCircuit1View(equipment, config)
      case 'circuit2':
        return buildHvacCircuit2View(equipment, config)
      case 'layout':
        return buildHvacLayoutView(equipment, config)
      case 'ambient':
        return buildHvacAmbientView(equipment, config, stats)
      default:
        return null
    }
  }

  return null
}

/**
 * GET /auth/dcs/cooling-system
 *
 * Returns cooling system data for the requested type and view.
 * App-node builds views from enriched equipment data fetched from DCS worker.
 * All values include units - app-node is completely agnostic to device details.
 *
 * Query params:
 * - type: 'miners' | 'hvac' (required)
 * - view: 'circuit1' | 'circuit2' | 'layout' | 'ambient' (required)
 * - overwriteCache: boolean (optional)
 */
async function getCoolingSystemData (ctx, req) {
  if (!isCentralDCSEnabled(ctx)) {
    throw new Error('ERR_FEATURE_NOT_ENABLED')
  }

  const { type, view } = req.query

  if (!type || !['miners', 'hvac'].includes(type)) {
    throw new Error('ERR_INVALID_TYPE')
  }

  const validViews = type === 'miners'
    ? ['circuit1', 'circuit2', 'layout']
    : ['circuit1', 'circuit2', 'layout', 'ambient']

  if (!view || !validViews.includes(view)) {
    throw new Error('ERR_INVALID_VIEW')
  }

  const dcsTag = getDCSTag(ctx)

  const fields = getFieldProjection(type, view)

  const payload = {
    query: { tags: { $in: [dcsTag] } },
    status: 1,
    fields
  }

  const needsRackStatuses = type === 'miners' && view === 'layout'
  const rackTailLogPayload = {
    keys: [
      { key: LOG_KEYS.STAT_RTD, type: WORKER_TYPES.MINER, tag: WORKER_TAGS.MINER }
    ],
    limit: 1,
    aggrFields: EXPLORER_RACK_AGGR_FIELDS
  }

  const [rpcResults, rackTailLogResults] = await Promise.all([
    ctx.dataProxy.requestDataMap('listThings', payload),
    needsRackStatuses
      ? ctx.dataProxy.requestDataMap('tailLogMulti', rackTailLogPayload)
      : Promise.resolve(null)
  ])

  const dcsThing = extractDcsThing(rpcResults)

  if (!dcsThing) {
    throw new Error('ERR_DCS_DATA_NOT_FOUND')
  }

  const snap = dcsThing.last.snap

  const rackPowerByRack = rackTailLogResults
    ? aggregateRackStats(rackTailLogResults).powerByRack
    : null

  const viewData = buildCoolingViewData(snap, type, view, rackPowerByRack)

  if (!viewData) {
    throw new Error('ERR_VIEW_DATA_NOT_AVAILABLE')
  }

  return {
    type,
    view,
    data: viewData
  }
}

module.exports = {
  getCoolingSystemData,
  getFieldProjection,
  buildCoolingViewData,
  buildMinersCircuit1View,
  buildMinersCircuit2View,
  buildMinersLayoutView,
  buildHvacCircuit1View,
  buildHvacCircuit2View,
  buildHvacLayoutView,
  buildHvacAmbientView
}
