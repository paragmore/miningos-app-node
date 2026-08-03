'use strict'

const DCS_TAG_DEFAULT = 't-dcs'

function isCentralDCSEnabled (ctx) {
  if (ctx.conf?.featureConfig?.centralDCSSetup?.enabled === true) return true
  return false
}

function getDCSTag (ctx) {
  return ctx.conf?.featureConfig?.centralDCSSetup?.tag || DCS_TAG_DEFAULT
}

function extractDcsThing (rpcResults) {
  if (!Array.isArray(rpcResults)) return null

  for (const orkResult of rpcResults) {
    if (!Array.isArray(orkResult)) continue
    for (const thing of orkResult) {
      if (thing && thing?.type && thing.type.includes('dcs') && thing?.last?.snap) {
        return thing
      }
    }
  }
  return null
}

// Site-wide power in watts from a DCS thing's "site_main" meter (reported in kW).
function extractSiteMainMeterPowerW (dcsThing) {
  const powerMeters = dcsThing?.last?.snap?.stats?.dcs_specific?.equipment?.power_meters || []
  const siteMeter = powerMeters.find(pm => pm.role === 'site_main')
  return (siteMeter?.power?.value || 0) * 1000
}

function extractMinerCoolingStatus (dcsThing) {
  return dcsThing?.last?.snap?.stats?.dcs_specific?.cooling_system?.status || 'Unavailable'
}

function getSensorReading (sensors, sensorId, defaultConfig = null) {
  if (!sensorId) return defaultConfig
  const sensor = sensors?.find(s => s.equipment === sensorId)
  if (!sensor) return defaultConfig
  // A configured sensor is present in the snap even when the DCS is offline;
  // keep its unit and surface value: null rather than dropping the reading.
  return { value: sensor.value ?? null, unit: sensor.unit ?? null }
}

// Like getSensorReading, but always surfaces the configured sensor id even when
// the tag isn't readable yet (value: null). Returns null only when no sensor is
// configured — so the UI can render the sensor label without a value.
function sensorReading (sensors, sensorId, unit = null) {
  if (!sensorId) return null
  const sensor = (sensors || []).find(s => s.equipment === sensorId)
  return { value: sensor?.value ?? null, unit: sensor?.unit || unit, sensor: sensorId }
}

function findEquipment (equipmentList, equipmentId) {
  if (!equipmentId || !Array.isArray(equipmentList)) return null
  return equipmentList.find(e => e.equipment === equipmentId)
}

function filterEquipmentBy (equipmentList, field, value) {
  if (!Array.isArray(equipmentList)) return []
  return equipmentList.filter(e => e[field] === value)
}

async function fetchDcsThing (ctx, fields) {
  const dcsTag = getDCSTag(ctx)

  const payload = {
    query: { tags: { $in: [dcsTag] } },
    status: 1,
    fields
  }

  const rpcResults = await ctx.dataProxy.requestDataMap('listThings', payload)
  return extractDcsThing(rpcResults)
}

module.exports = {
  DCS_TAG_DEFAULT,
  isCentralDCSEnabled,
  getDCSTag,
  extractDcsThing,
  extractSiteMainMeterPowerW,
  extractMinerCoolingStatus,
  getSensorReading,
  sensorReading,
  findEquipment,
  filterEquipmentBy,
  fetchDcsThing
}
