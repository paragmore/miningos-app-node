'use strict'

const { createMonthlyHashesCache } = require('./monthlyHashesCache')

/**
 * Hourly phase-consumption rows per phase and UTC month (see getPhaseConsumption).
 * Its own module rather than a metrics.handlers export because the manual-entry
 * write path (energy.handlers) must drop it the moment an entry lands, and
 * metrics.handlers already requires energy.handlers for the read path.
 *
 * The TTL covers what the write path cannot see: meter samples and manual rows
 * written straight to the stores (backfill scripts), which otherwise have no
 * way to invalidate a completed month.
 *
 * Far fewer distinct keys exist than for the hashrate rollups (months × a
 * handful of phases), and each entry is a whole month of hourly rows, so the
 * entry budget is kept well under the default.
 */
const phaseHourlyCache = createMonthlyHashesCache({ maxEntries: 120 })

// Bumped on every clear so a fetch that was already in flight when a write
// landed can tell its rows may predate it and must not be re-stored.
let generation = 0

function phaseHourlyCacheKey (monthKey, phaseId, source, meterKey) {
  return `${monthKey}|${phaseId}|${source}|${meterKey || ''}`
}

function phaseHourlyGeneration () {
  return generation
}

// Manual entries feed every phase: a manual-source phase reads them directly and
// a remainder one subtracts them from its meter, so a write drops the lot.
function clearPhaseHourlyCache () {
  generation++
  phaseHourlyCache.clear()
}

module.exports = { phaseHourlyCache, phaseHourlyCacheKey, phaseHourlyGeneration, clearPhaseHourlyCache }
