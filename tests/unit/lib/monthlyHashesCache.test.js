'use strict'

const test = require('brittle')
const { createMonthlyHashesCache } = require('../../../workers/lib/server/lib/monthlyHashesCache')
const { localMonthsInRange, localMonthKey } = require('../../../workers/lib/metrics.utils')

// Fixed -03:00 (Etc/GMT+3 is UTC-03:00 - POSIX inverts the sign), so the expected
// instants hold regardless of the runner's zone and of any DST rule.
const TZ = 'Etc/GMT+3'
const FLAGS = { nominal: true, pool: true }

test('monthlyHashesCache - a month is only reusable for the zone and series it was cut for', (t) => {
  const cache = createMonthlyHashesCache()

  t.not(cache.key('2026-08', TZ, FLAGS), cache.key('2026-08', 'UTC', FLAGS), 'zone is part of the key')
  t.not(
    cache.key('2026-08', TZ, FLAGS),
    cache.key('2026-08', TZ, { nominal: false, pool: true }),
    'a rollup without the nominal series is a different entry'
  )
  t.not(
    cache.key('2026-08', TZ, FLAGS),
    cache.key('2026-08', TZ, { ...FLAGS, siteNominal: true }),
    'a rollup against the site nominal is a different entry'
  )
  t.not(
    cache.key('2026-08', TZ, FLAGS),
    cache.key('2026-08', TZ, { ...FLAGS, container: 'container-A' }),
    'and a container-scoped month is not the site-wide one'
  )
  t.not(
    cache.key('2026-08', TZ, { ...FLAGS, container: 'container-A' }),
    cache.key('2026-08', TZ, { ...FLAGS, container: 'container-B' }),
    'nor another container\'s'
  )
  t.pass()
})

test('monthlyHashesCache - entries expire, and a miss is undefined rather than stale', (t) => {
  const cache = createMonthlyHashesCache({ ttlMs: 1000 })
  const key = cache.key('2026-08', TZ, FLAGS)

  cache.set(key, { ts: 1 }, 0)
  t.alike(cache.get(key, 999), { ts: 1 }, 'live inside the TTL')
  t.absent(cache.get(key, 1000), 'expired exactly at the TTL')
  t.is(cache.size, 0, 'and the expired entry is dropped, not left to grow')
  t.pass()
})

test('monthlyHashesCache - eviction follows use, not insertion', (t) => {
  const cache = createMonthlyHashesCache({ maxEntries: 2 })

  cache.set('a', 1)
  cache.set('b', 2)
  cache.get('a') // 'a' is now the most recently used
  cache.set('c', 3)

  t.is(cache.get('a'), 1, 'the re-read entry survives')
  t.absent(cache.get('b'), 'the untouched one is evicted')
  t.is(cache.get('c'), 3)
  t.pass()
})

test('localMonthsInRange - every month the range touches, with its own local bounds', (t) => {
  const months = localMonthsInRange(Date.UTC(2026, 7, 15), Date.UTC(2026, 9, 2), TZ)

  t.alike(months.map((m) => m.key), ['2026-08', '2026-09', '2026-10'], 'partial first and last months count')
  t.is(months[0].start, Date.UTC(2026, 7, 1, 3), 'local midnight, not UTC midnight')
  t.is(months[0].end, Date.UTC(2026, 8, 1, 3) - 1, 'ends the instant the next month starts')
  t.is(months[2].end - months[1].start + 1, Date.UTC(2026, 10, 1, 3) - Date.UTC(2026, 8, 1, 3), 'months tile the range without gaps')
  t.pass()
})

test('localMonthsInRange - a range inside one month yields that month alone', (t) => {
  const months = localMonthsInRange(Date.UTC(2026, 7, 10), Date.UTC(2026, 7, 11), TZ)

  t.is(months.length, 1)
  t.is(months[0].key, '2026-08')
  t.pass()
})

test('localMonthsInRange - crosses the year boundary', (t) => {
  const months = localMonthsInRange(Date.UTC(2026, 11, 5), Date.UTC(2027, 0, 5), TZ)

  t.alike(months.map((m) => m.key), ['2026-12', '2027-01'])
  t.pass()
})

test('localMonthKey - reads the month in the given zone, not UTC', (t) => {
  // 01:00 UTC on Sep 1 is 22:00 on Aug 31 at UTC-3
  t.is(localMonthKey(Date.UTC(2026, 8, 1, 1), TZ), '2026-08')
  t.is(localMonthKey(Date.UTC(2026, 8, 1, 1), 'UTC'), '2026-09')
  t.pass()
})
