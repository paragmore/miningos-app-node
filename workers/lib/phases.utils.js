'use strict'

const PHASE_TOTAL = 'total'

const CONSUMPTION_SOURCES = {
  REMAINDER: 'remainder',
  MANUAL: 'manual'
}

/**
 * Site phases from featureConfig. A phase is a slice of the site with its own
 * pool accounts and consumption source; sites without the config get null and
 * every endpoint behaves exactly as before.
 */
function getPhases (ctx) {
  const phases = ctx.conf?.featureConfig?.phases
  if (!Array.isArray(phases) || !phases.length) return null
  return phases
}

/**
 * Resolves the `phase` query param against the configured phases.
 * Returns null when no filtering applies (param absent, or `total`).
 * Throws ERR_PHASE_INVALID for an unknown id or when phases aren't configured.
 */
function resolvePhase (ctx, req) {
  const phaseId = req?.query?.phase
  if (!phaseId) return null

  const phases = getPhases(ctx)
  if (!phases) throw phaseError('ERR_PHASE_INVALID')
  if (phaseId === PHASE_TOTAL) return null

  const phase = phases.find((p) => p && p.id === phaseId)
  if (!phase) throw phaseError('ERR_PHASE_INVALID')
  return phase
}

function phaseError (code) {
  const err = new Error(code)
  err.statusCode = 400
  return err
}

/**
 * Pool identity set for a phase, as the `${poolType}:${username}` keys the
 * minerpool workers tag every stats/transactions/hashrate-history row with.
 */
function getPhaseAccountKeys (phase) {
  const keys = new Set()
  const accounts = phase?.pool?.accounts
  if (Array.isArray(accounts)) {
    for (const acc of accounts) {
      if (acc?.poolType && acc?.username) keys.add(`${acc.poolType}:${acc.username}`)
    }
  }
  // Always a Set for a phase - possibly empty. A phase without valid accounts
  // is scoped to nothing; returning null here would read as "unscoped" and
  // leak every account's data into the phase view.
  return keys
}

/**
 * Usernames of a phase's pool accounts, for row-level transaction filtering.
 */
function getPhaseUsernames (phase) {
  const names = new Set()
  const accounts = phase?.pool?.accounts
  if (Array.isArray(accounts)) {
    for (const acc of accounts) {
      if (acc?.username) names.add(acc.username)
    }
  }
  return names
}

/**
 * Receiver addresses whose pool rebates belong to a phase
 * (`pool.rebateAddresses`). Rebates are paid to a standalone address rather
 * than a pool account, so they need their own list; a phase without one
 * claims no rebates.
 */
function getPhaseRebateAddresses (phase) {
  const addresses = new Set()
  const configured = phase?.pool?.rebateAddresses
  if (Array.isArray(configured)) {
    for (const addr of configured) {
      if (typeof addr === 'string' && addr) addresses.add(addr)
    }
  }
  return addresses
}

function hasMinerTelemetry (phase) {
  return !phase || phase.minerTelemetry !== false
}

/**
 * Phases whose hashrate exists only at the pool (no MOS miners). Their pool
 * hashrate must be added wherever site efficiency divides power by
 * miner-telemetry hashrate, since their consumption is inside the site meter.
 */
function getPoolOnlyPhases (ctx) {
  const phases = getPhases(ctx)
  if (!phases) return []
  return phases.filter((p) => p && p.minerTelemetry === false)
}

/**
 * Pool identity set of every pool-only phase together: the accounts whose
 * hashrate the site efficiency divisor needs on top of miner telemetry.
 */
function getPoolOnlyAccountKeys (ctx) {
  const keys = new Set()
  for (const phase of getPoolOnlyPhases(ctx)) {
    for (const key of getPhaseAccountKeys(phase)) keys.add(key)
  }
  return keys
}

/**
 * Per-phase nominals from the ork global config (`phaseNominals` keyed by
 * phase id). `globalConfigResults` is the per-ork array that
 * RPC_METHODS.GLOBAL_CONFIG returns.
 */
function getPhaseNominals (globalConfigResults, phaseId) {
  if (!Array.isArray(globalConfigResults)) return null

  for (const entry of globalConfigResults) {
    const nominals = entry?.phaseNominals?.[phaseId]
    if (!nominals) continue

    return {
      hashrateMhs: Number.isFinite(nominals.nominalHashrate_MHS) ? nominals.nominalHashrate_MHS : null,
      powerMw: Number.isFinite(nominals.nominalPower_MW) ? nominals.nominalPower_MW : null,
      efficiencyWThs: Number.isFinite(nominals.nominalEfficiency_WTHS) ? nominals.nominalEfficiency_WTHS : null
    }
  }

  return null
}

/**
 * How a phase's consumption is measured: `manual` reads the hourly entries
 * logged on the DCS worker, `remainder` is a DCS meter (`meterKey`, a key of
 * by_meter_power_w) minus those manual entries. A phase without a usable source
 * fails loudly instead of falling back to the site series under its own tab.
 */
function getPhaseConsumptionSource (phase) {
  const source = phase?.consumption?.source
  if (source === CONSUMPTION_SOURCES.MANUAL) return { source }
  if (source === CONSUMPTION_SOURCES.REMAINDER) {
    const meterKey = phase.consumption.meterKey
    if (typeof meterKey !== 'string' || !meterKey) throw new Error('ERR_PHASE_CONSUMPTION_UNCONFIGURED')
    return { source, meterKey }
  }
  throw new Error('ERR_PHASE_CONSUMPTION_UNCONFIGURED')
}

const HOUR_MS = 60 * 60 * 1000

/**
 * Hour starts in [start, end] that have fully elapsed, i.e. the hours a phase's
 * consumption series is expected to cover. The running hour has no manual entry
 * yet by design, so it is not counted as missing.
 */
function elapsedHourStarts (start, end, now = Date.now()) {
  const last = Math.min(end, now - HOUR_MS)
  const hours = []
  for (let ts = Math.ceil(start / HOUR_MS) * HOUR_MS; ts <= last; ts += HOUR_MS) hours.push(ts)
  return hours
}

module.exports = {
  phaseError,
  PHASE_TOTAL,
  CONSUMPTION_SOURCES,
  getPhases,
  resolvePhase,
  getPhaseAccountKeys,
  getPhaseUsernames,
  getPhaseRebateAddresses,
  hasMinerTelemetry,
  getPoolOnlyPhases,
  getPoolOnlyAccountKeys,
  getPhaseNominals,
  getPhaseConsumptionSource,
  elapsedHourStarts
}
