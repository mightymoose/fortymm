import { describe, expect, it } from 'vitest'
import { createConnectResyncFilter } from './connect-resync'
import { UNKNOWN_EVENT_KIND, type DecodedEventKind, type RealtimeEvent } from './events'

/**
 * The suppression rule, in isolation: first event of the run, and only if it is
 * a `resync`.
 *
 * The end-to-end proof — one page load, one `/v1/dashboard` read; a resync after
 * a *reconnect* still refetching — lives in
 * `components/realtime-provider.test.tsx`, over a real stream. What is pinned
 * here is the arithmetic of the flag, which is where the two ways of getting
 * this wrong ("suppress every resync" / "suppress no resync") are cheapest to
 * catch.
 */

function event(kind: DecodedEventKind): RealtimeEvent {
  return { v: 1, kind, ts: '2026-07-25T00:26:37.607498Z' }
}

/** What a filter did with a whole run's worth of events, in order. */
function applied(kinds: readonly DecodedEventKind[]): DecodedEventKind[] {
  const shouldApply = createConnectResyncFilter()
  return kinds.filter((kind) => shouldApply(event(kind)))
}

describe('createConnectResyncFilter', () => {
  it('drops the connect-time resync', () => {
    expect(applied(['resync'])).toEqual([])
  })

  // The gap-recovery property. A reconnect after the server's ~15-minute
  // hang-up, or after a pub/sub recovery, arrives as another `resync` on the
  // same run — and nothing has refetched in the meantime, so swallowing it
  // would leave the dashboard stale until the user navigated.
  it('applies every later resync', () => {
    expect(applied(['resync', 'resync', 'resync'])).toEqual(['resync', 'resync'])
  })

  // Never suppressed: it reports a change that happened after the fetch the
  // mount did, so dropping it loses it outright.
  it('applies a dashboard.changed even as the run’s first event', () => {
    expect(applied(['dashboard.changed'])).toEqual(['dashboard.changed'])
  })

  // The first event spends the flag whatever its kind — otherwise "the first
  // event" quietly becomes "the first resync, whenever it turns up", and a
  // resync arriving after real traffic would be swallowed.
  it('does not carry the suppression past a non-resync first event', () => {
    expect(applied(['dashboard.changed', 'resync'])).toEqual([
      'dashboard.changed',
      'resync',
    ])
  })

  it('applies an unknown kind, first event or not', () => {
    expect(applied([UNKNOWN_EVENT_KIND, UNKNOWN_EVENT_KIND])).toEqual([
      UNKNOWN_EVENT_KIND,
      UNKNOWN_EVENT_KIND,
    ])
  })

  // Per run, not per process: a fresh mount (a reload, a sign-in) has fetched
  // again, so its own connect-time resync is redundant again.
  it('starts a new run un-spent', () => {
    expect(applied(['resync', 'dashboard.changed'])).toEqual(['dashboard.changed'])
    expect(applied(['resync'])).toEqual([])
  })
})
