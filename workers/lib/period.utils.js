'use strict'

const { PERIOD_TYPES, NON_METRIC_KEYS } = require('./constants')

// These helpers have no ctx, so they can't see the site's featureConfig.lockedTimezone.
// Rather than guess a zone (and bucket every other site on the wrong grid without a
// sound), a missing one throws - callers resolve it via resolveTimezone and pass it,
// or pass 'UTC' explicitly when they want the UTC grid.
function requireZone (timeZone, fn) {
  if (!timeZone) throw new Error(`${fn}: timezone is required`)
  return timeZone
}

const getStartOfDay = (ts) => Math.floor(ts / 86400000) * 86400000

// Milliseconds to add to a UTC instant to read it as wall-clock time in `timeZone`.
function zoneOffsetMs (ts, timeZone) {
  const parts = {}
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(new Date(ts))
  for (const { type, value } of formatted) parts[type] = value

  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second)
  return asUtc - ts
}

// True when `ts` is the first instant of a wall-clock hour in `timeZone` (DST-safe:
// the offset is taken at `ts`). The whole-minute check comes first because
// zoneOffsetMs only resolves seconds, so a sub-minute remainder would otherwise be
// absorbed into the offset. Mirrored by the DCS worker's consumption store.
function isLocalHourStart (ts, timeZone) {
  const zone = requireZone(timeZone, 'isLocalHourStart')
  if (!Number.isSafeInteger(ts) || ts < 0 || ts % 60000 !== 0) return false
  return (ts + zoneOffsetMs(ts, zone)) % 3600000 === 0
}

// First instant of the local calendar day (in `timeZone`) containing `ts`. DST-safe:
// resolved twice because the naive guess can land on the wrong side of a shift.
const localDayStart = (ts, timeZone) => {
  const zone = requireZone(timeZone, 'localDayStart')
  if (zone === 'UTC') return getStartOfDay(ts)

  const parts = {}
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(ts))
  for (const { type, value } of formatted) parts[type] = value

  const wallClock = Date.UTC(+parts.year, +parts.month - 1, +parts.day)
  const asTs = wallClock - zoneOffsetMs(wallClock, zone)
  const settled = zoneOffsetMs(asTs, zone)
  return settled === zoneOffsetMs(wallClock, zone) ? asTs : wallClock - settled
}

// First instant of the local day after the one containing `ts`. A local day is
// 23-25h across a DST shift, so a day and a half past its start always lands
// inside the next day, whichever way the clocks moved.
const nextLocalDayStart = (ts, timeZone) => {
  const zone = requireZone(timeZone, 'nextLocalDayStart')
  return localDayStart(localDayStart(ts, zone) + 1.5 * 86400000, zone)
}

const convertMsToSeconds = (timestampMs) => {
  return Math.floor(timestampMs / 1000)
}

// Y/M/D fields of `ts`, read in `timeZone`. 1-based month, matching Date's calendar
// fields elsewhere in this file.
const localDateParts = (ts, timeZone) => {
  const zone = requireZone(timeZone, 'localDateParts')
  const parts = {}
  for (const { type, value } of new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(ts))) parts[type] = value
  return { year: +parts.year, month: +parts.month, day: +parts.day }
}

// First instant of the local calendar month in `timeZone`. `month` is 1-based, matching
// localDateParts and localMonthKey. DST-safe via the same two-pass resolution as
// localDayStart.
const localMonthStartTs = (year, month, timeZone) => {
  const zone = requireZone(timeZone, 'localMonthStartTs')
  if (zone === 'UTC') return Date.UTC(year, month - 1, 1)

  const wallClock = Date.UTC(year, month - 1, 1)
  const asTs = wallClock - zoneOffsetMs(wallClock, zone)
  const settled = zoneOffsetMs(asTs, zone)
  return settled === zoneOffsetMs(wallClock, zone) ? asTs : wallClock - settled
}

const localYearStart = (year, timeZone) => localMonthStartTs(year, 1, timeZone)

// Monday-start local week (in `timeZone`) containing `ts`. Finance and pools both
// bucket weeks through this one function, so they can't drift apart.
const localWeekStart = (ts, timeZone) => {
  const zone = requireZone(timeZone, 'localWeekStart')
  const dayStart = localDayStart(ts, zone)
  const dow = new Date(dayStart + zoneOffsetMs(dayStart, zone)).getUTCDay() // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7
  if (!daysSinceMonday) return dayStart
  // A rough step back by whole days, corrected by re-deriving the exact local day
  // start - keeps the result right even if a DST shift falls inside the week.
  return localDayStart(dayStart - daysSinceMonday * 86400000, zone)
}

const aggregateByPeriod = (log, period, nonMetricKeys = [], options = {}) => {
  // Checked before the daily early return so a call site that forgets the zone fails
  // in its daily tests too, not only once someone requests weekly/monthly.
  const timeZone = requireZone(options.timezone, 'aggregateByPeriod')
  if (period === PERIOD_TYPES.DAILY) {
    return log
  }

  const allNonMetricKeys = new Set([...NON_METRIC_KEYS, ...nonMetricKeys])
  const meanKeys = new Set(options.meanKeys || [])

  const grouped = log.reduce((acc, entry) => {
    const ts = Number(entry.ts)
    if (!Number.isFinite(ts)) return acc

    let groupKey

    if (period === PERIOD_TYPES.MONTHLY) {
      const { year, month } = localDateParts(ts, timeZone)
      groupKey = `${year}-${String(month).padStart(2, '0')}`
    } else if (period === PERIOD_TYPES.YEARLY) {
      groupKey = `${localDateParts(ts, timeZone).year}`
    } else if (period === PERIOD_TYPES.WEEKLY) {
      groupKey = `${localWeekStart(ts, timeZone)}`
    } else {
      groupKey = `${entry.ts}`
    }

    if (!acc[groupKey]) {
      acc[groupKey] = []
    }
    acc[groupKey].push(entry)
    return acc
  }, {})

  const aggregatedResults = Object.entries(grouped).map(([groupKey, entries]) => {
    const meanCounts = {}
    const aggregated = entries.reduce((acc, entry) => {
      Object.entries(entry).forEach(([key, val]) => {
        if (allNonMetricKeys.has(key)) {
          if (!acc[key] || acc[key] === null || acc[key] === undefined) {
            acc[key] = val
          }
        } else if (meanKeys.has(key)) {
          if (val !== null && val !== undefined && !isNaN(Number(val))) {
            acc[key] = (acc[key] || 0) + Number(val)
            meanCounts[key] = (meanCounts[key] || 0) + 1
          }
        } else {
          const numVal = Number(val) || 0
          acc[key] = (acc[key] || 0) + numVal
        }
      })
      return acc
    }, {})

    for (const key of meanKeys) {
      aggregated[key] = meanCounts[key] ? aggregated[key] / meanCounts[key] : null
    }

    try {
      if (period === PERIOD_TYPES.MONTHLY) {
        const [year, month] = groupKey.split('-').map(Number)
        const ts = localMonthStartTs(year, month, timeZone)
        if (!Number.isFinite(ts)) {
          throw new Error(`Invalid date for monthly grouping: ${groupKey}`)
        }

        aggregated.ts = ts
        aggregated.month = month
        aggregated.year = year
        aggregated.monthName = new Date(ts).toLocaleString('en-US', { month: 'long', timeZone })
      } else if (period === PERIOD_TYPES.YEARLY) {
        const year = parseInt(groupKey)
        const ts = localYearStart(year, timeZone)
        if (!Number.isFinite(ts)) {
          throw new Error(`Invalid date for yearly grouping: ${groupKey}`)
        }

        aggregated.ts = ts
        aggregated.year = year
      } else if (period === PERIOD_TYPES.WEEKLY) {
        aggregated.ts = Number(groupKey)
      }
    } catch (error) {
      aggregated.ts = entries[0].ts

      try {
        const fallbackTs = Number(entries[0].ts)
        if (Number.isFinite(fallbackTs)) {
          const { year, month } = localDateParts(fallbackTs, timeZone)
          if (period === PERIOD_TYPES.MONTHLY) {
            aggregated.month = month
            aggregated.year = year
            aggregated.monthName = new Date(fallbackTs).toLocaleString('en-US', { month: 'long', timeZone })
          } else if (period === PERIOD_TYPES.YEARLY) {
            aggregated.year = year
          }
        }
      } catch (fallbackError) {
        console.warn('Could not extract date info from fallback timestamp', fallbackError)
      }
    }

    return aggregated
  })

  return aggregatedResults.sort((a, b) => Number(b.ts) - Number(a.ts))
}

module.exports = {
  getStartOfDay,
  zoneOffsetMs,
  isLocalHourStart,
  localDayStart,
  nextLocalDayStart,
  localWeekStart,
  localMonthStartTs,
  convertMsToSeconds,
  aggregateByPeriod,
  requireZone
}
