'use strict'

const test = require('brittle')
const {
  getStartOfDay,
  localDayStart,
  nextLocalDayStart,
  localWeekStart,
  localMonthStartTs,
  zoneOffsetMs,
  convertMsToSeconds,
  aggregateByPeriod,
  isLocalHourStart
} = require('../../../workers/lib/period.utils')
const metricsUtils = require('../../../workers/lib/metrics.utils')

test('getStartOfDay - returns start of day timestamp', (t) => {
  const ts = 1700050000000
  const result = getStartOfDay(ts)
  t.ok(result <= ts, 'should be less than or equal to input')
  t.is(result % 86400000, 0, 'should be divisible by 86400000')
  t.pass()
})

// ==================== localDayStart ====================

test('localDayStart - explicit UTC matches getStartOfDay', (t) => {
  const ts = Date.UTC(2026, 8, 1, 2)
  t.is(localDayStart(ts, 'UTC'), getStartOfDay(ts))
  t.pass()
})

test('localDayStart - aligns to local midnight for a non-UTC zone', (t) => {
  // 02:00 UTC on Sep 1 is still Aug 31 22:00 in America/Campo_Grande (UTC-4).
  const ts = Date.UTC(2026, 8, 1, 2)
  t.is(localDayStart(ts, 'America/Campo_Grande'), Date.UTC(2026, 7, 31, 4))
  t.pass()
})

test('localDayStart - throws without a timezone instead of guessing one', async (t) => {
  const ts = Date.UTC(2026, 8, 1, 2)
  await t.exception(() => localDayStart(ts), /localDayStart: timezone is required/)
  await t.exception(() => localDayStart(ts, ''), /localDayStart: timezone is required/)
  t.is(localDayStart(ts, 'UTC'), getStartOfDay(ts), 'UTC has to be asked for explicitly')
  t.pass()
})

test('localDayStart - aligns to local midnight, not UTC midnight', (t) => {
  // 2026-01-05 23:30 UTC is still 2026-01-05 in America/New_York (UTC-5), but
  // already 2026-01-06 in UTC - the local day start must differ from the UTC one.
  const ts = Date.UTC(2026, 0, 5, 23, 30)
  const utcDayStart = localDayStart(ts, 'UTC')
  const nyDayStart = localDayStart(ts, 'America/New_York')
  t.is(utcDayStart, Date.UTC(2026, 0, 5), 'UTC day start is UTC midnight')
  t.is(nyDayStart, Date.UTC(2026, 0, 5, 5), 'NY day start is 05:00 UTC (local midnight)')
  t.pass()
})

// ==================== nextLocalDayStart ====================

test('nextLocalDayStart - is the next local midnight from anywhere in the day', (t) => {
  const zone = 'America/New_York'
  const dayStart = Date.UTC(2026, 0, 5, 5)
  t.is(nextLocalDayStart(dayStart, zone), Date.UTC(2026, 0, 6, 5), 'from the day start')
  t.is(nextLocalDayStart(dayStart + 86400000 - 1, zone), Date.UTC(2026, 0, 6, 5), 'from its last ms')
  t.is(nextLocalDayStart(Date.UTC(2026, 0, 5, 12), 'UTC'), Date.UTC(2026, 0, 6))
  t.pass()
})

test('nextLocalDayStart - spans the 23h and 25h days of a DST shift', (t) => {
  const zone = 'America/New_York'
  // 2026-03-08 springs forward (23h), 2026-11-01 falls back (25h).
  const springDay = Date.UTC(2026, 2, 8, 5)
  t.is(nextLocalDayStart(springDay, zone) - springDay, 23 * 3600000)
  const fallDay = Date.UTC(2026, 10, 1, 4)
  t.is(nextLocalDayStart(fallDay, zone) - fallDay, 25 * 3600000)
  t.is(nextLocalDayStart(fallDay + 24.5 * 3600000, zone), Date.UTC(2026, 10, 2, 5), 'from the repeated hour')
  t.pass()
})

test('localWeekStart - buckets Mon-Sun into the same Monday-start week', (t) => {
  const monday = Date.UTC(2026, 0, 5)
  const sunday = Date.UTC(2026, 0, 11, 12)
  t.is(localWeekStart(monday, 'UTC'), monday, 'monday is its own week start')
  t.is(localWeekStart(sunday, 'UTC'), monday, 'sunday rolls back to monday')
  t.pass()
})

test('localMonthStartTs - month is 1-based', (t) => {
  t.is(localMonthStartTs(2026, 1, 'UTC'), Date.UTC(2026, 0, 1), 'January is 1')
  t.is(localMonthStartTs(2026, 12, 'UTC'), Date.UTC(2026, 11, 1), 'December is 12')
  // Campo_Grande is UTC-4 year-round, so local midnight on Sep 1 is 04:00 UTC.
  t.is(localMonthStartTs(2026, 9, 'America/Campo_Grande'), Date.UTC(2026, 8, 1, 4))
  t.pass()
})

test('localMonthStartTs - throws without a timezone', async (t) => {
  await t.exception(() => localMonthStartTs(2026, 1), /localMonthStartTs: timezone is required/)
  t.pass()
})

test('metrics.utils re-exports the period.utils zone helpers rather than its own copies', (t) => {
  t.is(metricsUtils.zoneOffsetMs, zoneOffsetMs)
  t.is(metricsUtils.localMonthStartTs, localMonthStartTs)
  t.pass()
})

test('getStartOfDay - already at start of day', (t) => {
  const ts = 1700006400000
  const result = getStartOfDay(ts)
  t.is(result, ts, 'should return same timestamp if already start of day')
  t.pass()
})

test('aggregateByPeriod - returns log unchanged for daily period', (t) => {
  const log = [
    { ts: 1700006400000, value: 10 },
    { ts: 1700092800000, value: 20 }
  ]
  const result = aggregateByPeriod(log, 'daily', [], { timezone: 'UTC' })
  t.is(result.length, 2, 'should return same length')
  t.alike(result, log, 'should return same entries')
  t.pass()
})

test('aggregateByPeriod - aggregates monthly', (t) => {
  const log = [
    { ts: 1700006400000, value: 10, region: 'us' },
    { ts: 1700092800000, value: 20, region: 'us' }
  ]
  const result = aggregateByPeriod(log, 'monthly', [], { timezone: 'UTC' })
  t.ok(result.length >= 1, 'should have at least one aggregated entry')
  t.ok(result[0].month, 'should have month field')
  t.ok(result[0].year, 'should have year field')
  t.pass()
})

test('aggregateByPeriod - aggregates yearly', (t) => {
  const log = [
    { ts: 1700006400000, value: 10, region: 'us' },
    { ts: 1700092800000, value: 20, region: 'us' }
  ]
  const result = aggregateByPeriod(log, 'yearly', [], { timezone: 'UTC' })
  t.ok(result.length >= 1, 'should have at least one aggregated entry')
  t.ok(result[0].year, 'should have year field')
  t.pass()
})

test('aggregateByPeriod - handles empty log', (t) => {
  const result = aggregateByPeriod([], 'monthly', [], { timezone: 'UTC' })
  t.is(result.length, 0, 'should return empty array')
  t.pass()
})

test('aggregateByPeriod - handles invalid timestamps', (t) => {
  const log = [
    { ts: 'invalid', value: 10 },
    { ts: 1700006400000, value: 20 }
  ]
  const result = aggregateByPeriod(log, 'monthly', [], { timezone: 'UTC' })
  t.ok(result.length >= 1, 'should skip invalid entries')
  t.pass()
})

test('aggregateByPeriod - meanKeys option averages instead of summing', (t) => {
  const ts = Date.UTC(2024, 0, 15)
  const log = [
    { ts, total: 10, rate: 0.1 },
    { ts: ts + 86400000, total: 20, rate: 0.3 }
  ]
  const result = aggregateByPeriod(log, 'monthly', [], { timezone: 'UTC', meanKeys: ['rate'] })
  t.is(result.length, 1, 'one monthly bucket')
  t.is(result[0].total, 30, 'sum keys still summed')
  t.is(result[0].rate, 0.2, 'mean key averaged: (0.1+0.3)/2')
})

test('aggregateByPeriod - meanKeys skip null/undefined values when averaging', (t) => {
  const ts = Date.UTC(2024, 0, 15)
  const log = [
    { ts, rate: 0.1 },
    { ts: ts + 86400000, rate: null },
    { ts: ts + 2 * 86400000, rate: 0.3 }
  ]
  const result = aggregateByPeriod(log, 'monthly', [], { timezone: 'UTC', meanKeys: ['rate'] })
  t.is(result[0].rate, 0.2, 'null skipped: (0.1+0.3)/2')
})

test('aggregateByPeriod - meanKeys returns null when no entries have the value', (t) => {
  const ts = Date.UTC(2024, 0, 15)
  const log = [
    { ts, rate: null },
    { ts: ts + 86400000, rate: undefined }
  ]
  const result = aggregateByPeriod(log, 'monthly', [], { timezone: 'UTC', meanKeys: ['rate'] })
  t.is(result[0].rate, null, 'all-null group yields null')
})

test('aggregateByPeriod - omitting options preserves legacy sum-everything behaviour', (t) => {
  const ts = Date.UTC(2024, 0, 15)
  const log = [
    { ts, rate: 0.1 },
    { ts: ts + 86400000, rate: 0.3 }
  ]
  const result = aggregateByPeriod(log, 'monthly', [], { timezone: 'UTC' })
  t.is(result[0].rate, 0.4, 'rate is summed when meanKeys not provided')
})

test('convertMsToSeconds - converts milliseconds to seconds', (t) => {
  t.is(convertMsToSeconds(1700006400000), 1700006400, 'should convert ms to seconds')
  t.is(convertMsToSeconds(1700006400500), 1700006400, 'should floor fractional seconds')
  t.pass()
})

test('aggregateByPeriod - monthly buckets are grouped and stamped in the given zone', (t) => {
  const log = [
    { ts: Date.UTC(2026, 7, 1), revenueBTC: 1 },
    { ts: Date.UTC(2026, 7, 2), revenueBTC: 2 }
  ]

  const [month] = aggregateByPeriod(log, 'monthly', [], { timezone: 'UTC' })

  t.is(month.ts, Date.UTC(2026, 7, 1), 'stamped on the UTC first of the month')
  t.is(month.month, 8)
  t.is(month.monthName, 'August', 'named from the UTC month, not the host month')
  t.is(month.revenueBTC, 3, 'both UTC days land in the same bucket')
  t.pass()
})

test('aggregateByPeriod - yearly buckets are grouped and stamped in the given zone', (t) => {
  const log = [
    { ts: Date.UTC(2026, 0, 1), revenueBTC: 1 },
    { ts: Date.UTC(2026, 11, 31), revenueBTC: 2 }
  ]

  const [year] = aggregateByPeriod(log, 'yearly', [], { timezone: 'UTC' })

  t.is(year.ts, Date.UTC(2026, 0, 1), 'stamped on the UTC first of the year')
  t.is(year.year, 2026)
  t.is(year.revenueBTC, 3, 'both UTC days land in the same bucket')
  t.pass()
})

test('aggregateByPeriod - monthly cuts in the resolved zone, not UTC', (t) => {
  // 02:00 UTC on Sep 1 is still Aug 31 in America/Campo_Grande (UTC-4).
  const log = [
    { ts: Date.UTC(2026, 7, 31, 20), revenueBTC: 1 },
    { ts: Date.UTC(2026, 8, 1, 2), revenueBTC: 2 }
  ]

  const [month] = aggregateByPeriod(log, 'monthly', [], { timezone: 'America/Campo_Grande' })

  t.is(month.month, 8, 'both entries fall in the local August, not a UTC-split August/September')
  t.is(month.revenueBTC, 3, 'both entries land in the same local-month bucket')
  t.pass()
})

test('aggregateByPeriod - weekly buckets are Monday-start in the resolved zone, matching pools', (t) => {
  // Sep 2 2026 is a Wednesday, and Aug 31 2026 is the Monday of its local week in
  // America/Campo_Grande (UTC-4).
  const log = [
    { ts: Date.UTC(2026, 8, 2, 12), revenueBTC: 1 },
    { ts: Date.UTC(2026, 8, 3, 12), revenueBTC: 2 }
  ]

  const [week] = aggregateByPeriod(log, 'weekly', [], { timezone: 'America/Campo_Grande' })

  t.is(week.ts, Date.UTC(2026, 7, 31, 4), 'stamped on the Monday-start local week, not the UTC Sunday-start week')
  t.is(week.revenueBTC, 3, 'both entries land in the same local week')
  t.pass()
})

test('aggregateByPeriod - throws without a timezone option, daily included', async (t) => {
  const log = [{ ts: Date.UTC(2026, 8, 2, 12), revenueBTC: 1 }]
  await t.exception(() => aggregateByPeriod(log, 'weekly'), /aggregateByPeriod: timezone is required/)
  await t.exception(() => aggregateByPeriod(log, 'daily'), /aggregateByPeriod: timezone is required/,
    'daily never uses the zone, but still rejects a call site that forgot it')
  t.pass()
})

test('isLocalHourStart - follows the site zone grid, not the UTC grid', async (t) => {
  const H0 = Date.UTC(2026, 0, 1)
  const MIN = 60000
  t.ok(isLocalHourStart(H0, 'UTC'))
  t.absent(isLocalHourStart(H0 + 30 * MIN, 'UTC'))
  t.ok(isLocalHourStart(H0 + 30 * MIN, 'Asia/Kolkata'), '+5:30 hours start at :30 UTC')
  t.absent(isLocalHourStart(H0, 'Asia/Kolkata'))
  t.ok(isLocalHourStart(H0, 'America/Campo_Grande'))
})

test('isLocalHourStart - takes the offset at ts across DST', async (t) => {
  // Australia/Lord_Howe: +11:00 in southern summer, +10:30 in winter
  const jan = Date.UTC(2026, 0, 15)
  const jul = Date.UTC(2026, 6, 15)
  t.ok(isLocalHourStart(jan, 'Australia/Lord_Howe'))
  t.absent(isLocalHourStart(jan + 1800000, 'Australia/Lord_Howe'))
  t.ok(isLocalHourStart(jul + 1800000, 'Australia/Lord_Howe'))
  t.absent(isLocalHourStart(jul, 'Australia/Lord_Howe'))
  // New York fall-back: 01:00 EDT and 01:00 EST are distinct valid hours
  t.ok(isLocalHourStart(Date.UTC(2026, 10, 1, 5), 'America/New_York'))
  t.ok(isLocalHourStart(Date.UTC(2026, 10, 1, 6), 'America/New_York'))
})

test('isLocalHourStart - rejects sub-minute remainders, non-integers and a missing zone', async (t) => {
  const H0 = Date.UTC(2026, 0, 1)
  t.absent(isLocalHourStart(H0 + 500, 'UTC'))
  t.absent(isLocalHourStart(H0 + 1800500, 'Asia/Kolkata'), 'not absorbed into the zone offset')
  t.absent(isLocalHourStart(H0 + 0.5, 'UTC'))
  t.absent(isLocalHourStart(String(H0), 'UTC'))
  t.absent(isLocalHourStart(-3600000, 'UTC'))
  await t.exception(() => isLocalHourStart(H0), /isLocalHourStart: timezone is required/)
})
