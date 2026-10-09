'use strict'

// A calendar month that has ended cannot gain hours, so its rollup is reusable.
// It can still gain late-arriving samples inside those hours (a pool backfill),
// which is what the TTL is for - this is a cost cache, not a source of truth.
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 500

/**
 * Least-recently-used cache of completed monthly hashrate rollups.
 *
 * Only whole months in the past are ever offered to it: the running month still
 * gains hours, so it is recomputed on every request (see getMonthlyHashrate).
 * Deliberately per-process and unshared - a restart simply repays the first
 * request, and there is nothing to invalidate across workers.
 */
function createMonthlyHashesCache ({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const entries = new Map()

  return {
    // A month's rollup depends on the zone it was cut in, on the slice of the site it
    // covers, and on whether the caller asked for the nominal and pool series at all.
    // Everything that changes the numbers has to be in here: a scoped request that
    // shared a key with the site-wide one would serve its numbers for the whole TTL.
    key (monthKey, timezone, { nominal, siteNominal, pool, container, phase } = {}) {
      return `${monthKey}|${timezone}|${container || ''}|${phase || ''}|${nominal ? 'n' : ''}${siteNominal ? 's' : ''}${pool ? 'p' : ''}`
    },

    get (key, now = Date.now()) {
      const hit = entries.get(key)
      if (!hit) return undefined
      if (hit.expiresAt <= now) {
        entries.delete(key)
        return undefined
      }

      // Re-insert so eviction order tracks use, not insertion.
      entries.delete(key)
      entries.set(key, hit)
      return hit.value
    },

    set (key, value, now = Date.now()) {
      entries.delete(key)
      entries.set(key, { value, expiresAt: now + ttlMs })

      while (entries.size > maxEntries) entries.delete(entries.keys().next().value)
    },

    clear () {
      entries.clear()
    },

    get size () {
      return entries.size
    }
  }
}

module.exports = { createMonthlyHashesCache, DEFAULT_TTL_MS, DEFAULT_MAX_ENTRIES }
