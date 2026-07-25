import { describe, expect, it } from 'vitest'

import { DASHBOARD_QUERY_KEY } from '../dashboard'
import { decodeRealtimeEvent, UNKNOWN_EVENT_KIND, type DecodedEventKind } from './events'
import { queryKeysToInvalidate } from './invalidation'

const TS = '2026-07-25T00:26:37.607498Z'

const event = (kind: DecodedEventKind) => ({ v: 1 as const, kind, ts: TS })

describe('queryKeysToInvalidate', () => {
  it.each<[DecodedEventKind]>([
    ['dashboard.changed'],
    ['resync'],
    [UNKNOWN_EVENT_KIND],
  ])('invalidates the dashboard for %s', (kind) => {
    expect(queryKeysToInvalidate(event(kind))).toEqual([DASHBOARD_QUERY_KEY])
  })

  it('uses the dashboard query key factory, not a re-spelled literal', () => {
    // If `DASHBOARD_QUERY_KEY` changes, this map must move with it — importing
    // the key is what guarantees that, and this asserts identity, not shape.
    expect(queryKeysToInvalidate(event('dashboard.changed'))[0]).toBe(DASHBOARD_QUERY_KEY)
  })

  it('refreshes coarsely for a kind a newer server invented', () => {
    // End to end from the wire: an unreadable kind still moves the dashboard,
    // rather than being dropped on the floor.
    const decoded = decodeRealtimeEvent(`{"v":1,"kind":"tournament.changed","ts":"${TS}"}`)

    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(queryKeysToInvalidate(decoded.event)).toEqual([DASHBOARD_QUERY_KEY])
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
