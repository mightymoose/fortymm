import { describe, expect, it } from 'vitest'

import { DASHBOARD_QUERY_KEY } from '../dashboard'
import { MATCH_QUERY_KEY_PREFIX } from '../matches'
import { MATCH_DETAILS_QUERY_KEY_PREFIX } from '@/components/matches/match-details/match-details-query'
import { decodeRealtimeEvent, UNKNOWN_EVENT_KIND, type DecodedEventKind } from './events'
import { queryKeysToInvalidate } from './invalidation'

const TS = '2026-07-25T00:26:37.607498Z'

const event = (kind: DecodedEventKind) => ({ v: 1 as const, kind, ts: TS })

// Every kind refreshes the dashboard AND every open match screen (#1661 item
// 6): `useMatch`'s cache (`matchQueryKey`) and the scoreboard/score-entry
// cache (`matchDetailsQueryKey`) alike, via their shared prefixes.
const EXPECTED_KEYS = [
  DASHBOARD_QUERY_KEY,
  MATCH_QUERY_KEY_PREFIX,
  MATCH_DETAILS_QUERY_KEY_PREFIX,
]

describe('queryKeysToInvalidate', () => {
  it.each<[DecodedEventKind]>([
    ['dashboard.changed'],
    ['resync'],
    [UNKNOWN_EVENT_KIND],
  ])('invalidates the dashboard and every open match view for %s', (kind) => {
    expect(queryKeysToInvalidate(event(kind))).toEqual(EXPECTED_KEYS)
  })

  it('uses the dashboard and match query key factories, not re-spelled literals', () => {
    // If a key factory changes, this map must move with it — importing the
    // key is what guarantees that, and this asserts identity, not shape.
    const keys = queryKeysToInvalidate(event('dashboard.changed'))
    expect(keys[0]).toBe(DASHBOARD_QUERY_KEY)
    expect(keys[1]).toBe(MATCH_QUERY_KEY_PREFIX)
    expect(keys[2]).toBe(MATCH_DETAILS_QUERY_KEY_PREFIX)
  })

  it('refreshes coarsely for a kind a newer server invented', () => {
    // End to end from the wire: an unreadable kind still moves the dashboard
    // and every open match view, rather than being dropped on the floor.
    const decoded = decodeRealtimeEvent(`{"v":1,"kind":"tournament.changed","ts":"${TS}"}`)

    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(queryKeysToInvalidate(decoded.event)).toEqual(EXPECTED_KEYS)
  })

  it('names every key it returns', () => {
    // A key must never come back `undefined` — invalidating an undefined key
    // invalidates the entire cache.
    for (const kind of ['dashboard.changed', 'resync', UNKNOWN_EVENT_KIND] as const) {
      const keys = queryKeysToInvalidate(event(kind))
      expect(keys.length).toBeGreaterThan(0)
      expect(keys.every((key) => Array.isArray(key) && key.length > 0)).toBe(true)
    }
  })
})
