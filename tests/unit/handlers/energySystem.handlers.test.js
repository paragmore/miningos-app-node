'use strict'

const test = require('brittle')
const {
  buildLayoutView,
  buildMinersView
} = require('../../../workers/lib/server/handlers/energy.system.handlers')

const siteMeter = () => ({
  equipment: 'PM-MV',
  role: 'site_main',
  name: 'Site PM',
  power: { value: 8412, unit: 'kW' },
  current: {
    l1: { value: 100, unit: 'A' },
    l2: { value: 110, unit: 'A' },
    l3: { value: 120, unit: 'A' },
    total: { value: 330, unit: 'A' }
  }
})

const branchMeter = () => ({
  equipment: 'QGBT-01',
  role: 'rack',
  name: 'QGBT-01',
  power: { value: 654.18, unit: 'kW' },
  power_factor: 0.98,
  reactive_power: { value: 12, unit: 'kVAR' },
  total_energy: { value: 5000, unit: 'kWh' },
  voltage: {
    l1_n: { value: 220, unit: 'V' },
    l2_n: { value: 221, unit: 'V' },
    l3_n: { value: 219, unit: 'V' },
    l1_l2: { value: 380, unit: 'V' },
    l2_l3: { value: 381, unit: 'V' },
    l3_l1: { value: 379, unit: 'V' }
  },
  current: {
    l1: { value: 1549, unit: 'A' },
    l2: { value: 1395, unit: 'A' },
    l3: { value: 1541, unit: 'A' },
    neutral: { value: 12, unit: 'A' },
    total: { value: 4485, unit: 'A' }
  }
})

// The branch breaker (QGBT-0x-CB) reports switching state but no metering tags,
// so the SLD needs the branch meter's voltage/current, not just its power.
test('BE-8 - energy layout branch meter exposes voltage and current', (t) => {
  const equipment = {
    power_meters: [siteMeter(), branchMeter()],
    protection_relays: [],
    transformers: [],
    distribution_boards: []
  }
  const config = {
    energy_layout: {
      branches: [{ feeds: 'Groups 1-4', meter: 'QGBT-01' }]
    }
  }
  const view = buildLayoutView(equipment, config, {})
  const { meter } = view.branches[0]

  t.is(meter.equipment, 'QGBT-01', 'meter is resolved by equipment id')
  t.is(meter.name, 'QGBT-01', 'meter name is exposed')
  t.is(meter.power.value, 654.18, 'meter power is exposed')
  t.is(meter.voltage.l1_n.value, 220, 'meter phase-to-neutral voltage is exposed')
  t.is(meter.current.l1.value, 1549, 'meter phase current is exposed')
  t.absent(meter.total_energy, 'total_energy stays out of the SLD payload')
  t.absent(meter.reactive_power, 'reactive_power stays out of the SLD payload')
  t.pass()
})

test('BE-8 - energy layout branch meter is null when unresolved', (t) => {
  const equipment = {
    power_meters: [siteMeter()],
    protection_relays: [],
    transformers: [],
    distribution_boards: []
  }
  const config = {
    energy_layout: {
      branches: [{ feeds: 'Groups 1-4', meter: 'QGBT-99' }]
    }
  }
  const view = buildLayoutView(equipment, config, {})

  t.is(view.branches[0].meter, null, 'unmatched meter id yields null')
  t.pass()
})

test('BE-8 - energy layout site_pm exposes current.total from BE', (t) => {
  const equipment = { power_meters: [siteMeter()], protection_relays: [], transformers: [], distribution_boards: [] }
  const config = { energy_layout: {} }
  const view = buildLayoutView(equipment, config, {})

  t.ok(view.site_pm, 'has site_pm')
  t.ok(view.site_pm.current, 'site_pm has current')
  t.is(view.site_pm.current.total.value, 330, 'current.total comes from BE')
  t.is(view.site_pm.current.total.unit, 'A', 'current.total has unit')
  t.pass()
})

test('BE-8 - miners view site_total resolves from site_main meter', (t) => {
  const equipment = { power_meters: [siteMeter()] }
  const view = buildMinersView(equipment, {}, {})

  t.ok(view.site_total, 'has site_total')
  t.pass()
})
