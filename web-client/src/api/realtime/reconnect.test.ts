import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RECONNECT_BASE_MS,
  MAX_RECONNECT_DELAY_MS,
  MIN_RECONNECT_BASE_MS,
  nextFailureCount,
  reconnectDelayMs,
  STABLE_CONNECTION_MS,
} from './reconnect'

/** The server's directive in the middle of the band `/v1/stream` jitters over. */
const DIRECTIVE = 5_000

/** A `random()` pinned to the top of its range, so a delay reads as the CEILING
 * the policy computed rather than as a sample from it. `1` is not a value
 * `Math.random()` can return, which is the point: it makes the assertion about
 * the interval, not about a draw. */
const ceilingOf = () => 1

describe('nextFailureCount', () => {
  it('forgives a connection that stayed open, however many preceded it', () => {
    expect(nextFailureCount(7, STABLE_CONNECTION_MS)).toBe(0)
    expect(nextFailureCount(7, 15 * 60_000)).toBe(0)
  })

  it('counts one that did not', () => {
    expect(nextFailureCount(0, 0)).toBe(1)
    expect(nextFailureCount(1, 250)).toBe(2)
    expect(nextFailureCount(2, STABLE_CONNECTION_MS - 1)).toBe(3)
  })

  // The server hangs up on every stream at ~15 minutes by design, so the
  // commonest disconnection in the app is not a failure. Were duration not the
  // test, a healthy tab would escalate its own backoff every quarter hour until
  // it was reconnecting once a minute — and a dashboard would go a minute stale
  // on nothing but uptime.
  it('reads the server’s scheduled 15-minute hang-up as healthy', () => {
    expect(nextFailureCount(0, 15 * 60_000)).toBe(0)
  })
})

describe('reconnectDelayMs', () => {
  it('takes the server’s retry directive as the base', () => {
    expect(reconnectDelayMs(0, DIRECTIVE, ceilingOf)).toBe(DIRECTIVE)
  })

  it('falls back to the default before the server has sent one', () => {
    expect(reconnectDelayMs(0, null, ceilingOf)).toBe(DEFAULT_RECONNECT_BASE_MS)
  })

  it('is FULL jitter — uniform across the whole interval, not a narrow band', () => {
    expect(reconnectDelayMs(0, DIRECTIVE, () => 0)).toBe(0)
    expect(reconnectDelayMs(0, DIRECTIVE, () => 0.5)).toBe(DIRECTIVE / 2)
    expect(reconnectDelayMs(0, DIRECTIVE, ceilingOf)).toBe(DIRECTIVE)
  })

  it('doubles the ceiling per consecutive failure, after the first', () => {
    const ceilings = [0, 1, 2, 3, 4].map((failures) =>
      reconnectDelayMs(failures, DIRECTIVE, ceilingOf),
    )
    // 0 and 1 share the base: one blip should cost what the server asked for,
    // not twice it.
    expect(ceilings).toEqual([5_000, 5_000, 10_000, 20_000, 40_000])
  })

  it('caps the escalation so a long outage settles rather than backs off forever', () => {
    expect(reconnectDelayMs(20, DIRECTIVE, ceilingOf)).toBe(MAX_RECONNECT_DELAY_MS)
  })

  it('floors the base, so `retry: 0` cannot become a request loop', () => {
    expect(reconnectDelayMs(0, 0, ceilingOf)).toBe(MIN_RECONNECT_BASE_MS)
  })

  // The cap bounds the ESCALATION, not the server's own instruction. A test
  // harness parks a stubbed stream by answering with a very long `retry:`, and
  // clamping that down to a minute would put every MSW-off browser spec back
  // into a reconnect loop.
  it('honours a directive longer than the escalation cap', () => {
    const hour = 3_600_000
    expect(reconnectDelayMs(0, hour, ceilingOf)).toBe(hour)
    expect(reconnectDelayMs(1, hour, ceilingOf)).toBe(hour)
  })
})
