'use strict'

const test = require('brittle')
const {
  resolvePhase,
  getPhaseAccountKeys,
  getPhaseUsernames,
  hasMinerTelemetry,
  getPoolOnlyPhases,
  getPhaseNominals
} = require('../../../workers/lib/phases.utils')

const PHASES = [
  { id: 'total', label: 'Total Site' },
  {
    id: 'phase1',
    label: 'Phase 1',
    pool: { accounts: [{ poolType: 'ocean', username: 'addr1' }] },
    minerTelemetry: true
  },
  {
    id: 'phase1_5',
    label: 'Phase 1.5',
    pool: { accounts: [{ poolType: 'ocean', username: 'addr2' }] },
    consumption: { source: 'manual' },
    minerTelemetry: false,
    groups: { minerType: 'HBM', container: 'acme-container' }
  }
]

function ctxWith (phases) {
  return { conf: { featureConfig: phases ? { phases } : {} } }
}

test('resolvePhase - absent and total are no-ops, ids resolve, junk rejects', (t) => {
  const ctx = ctxWith(PHASES)

  t.is(resolvePhase(ctx, { query: {} }), null)
  t.is(resolvePhase(ctx, { query: { phase: 'total' } }), null)
  t.is(resolvePhase(ctx, { query: { phase: 'phase1_5' } }).id, 'phase1_5')

  try {
    resolvePhase(ctx, { query: { phase: 'phase15' } })
    t.fail('unknown id must throw')
  } catch (err) {
    t.is(err.message, 'ERR_PHASE_INVALID')
    t.is(err.statusCode, 400)
  }

  t.exception(() => resolvePhase(ctxWith(null), { query: { phase: 'phase1' } }), /ERR_PHASE_INVALID/)
})

test('account helpers and pool-only selection', (t) => {
  const phase = PHASES[2]

  t.alike([...getPhaseAccountKeys(phase)], ['ocean:addr2'])
  t.alike([...getPhaseUsernames(phase)], ['addr2'])
  t.is(getPhaseAccountKeys(PHASES[0]).size, 0, 'a phase without accounts is scoped to nothing')
  t.is(getPhaseUsernames(PHASES[0]).size, 0)

  t.is(hasMinerTelemetry(null), true, 'no phase means the site series')
  t.is(hasMinerTelemetry(PHASES[1]), true)
  t.is(hasMinerTelemetry(phase), false)

  t.alike(getPoolOnlyPhases(ctxWith(PHASES)).map((p) => p.id), ['phase1_5'])
  t.alike(getPoolOnlyPhases(ctxWith(null)), [])
})

test('getPhaseNominals - joins the per-ork global config by phase id', (t) => {
  const results = [
    { nominalSiteHashrate_MHS: 7e11 },
    { phaseNominals: { phase1_5: { nominalHashrate_MHS: 5.076e10, nominalPower_MW: 0.87, nominalEfficiency_WTHS: 17.2 } } }
  ]

  t.alike(getPhaseNominals(results, 'phase1_5'), { hashrateMhs: 5.076e10, powerMw: 0.87, efficiencyWThs: 17.2 })
  t.is(getPhaseNominals(results, 'phase1'), null)
  t.is(getPhaseNominals(undefined, 'phase1'), null)
})
