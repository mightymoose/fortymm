import { describe, expect, it } from 'vitest'

import { ApiError } from '@/api/client'
import { buildScheduleSolveRead } from '@/mocks/factories/tournaments/tournament.factory'

import { buildScheduleSolve } from './seed.factory'
import {
  LIVE_POLL_MS,
  SOLVE_IN_FLIGHT_POLL_MS,
  fmtWallTime,
  parseLatestScheduleSolve,
  parseScheduleSolve,
  runSchedulerNotice,
  scheduleRefetchInterval,
  solveInFlight,
  solveStripState,
} from './solve'

// ----- the parse boundary ----------------------------------------------------

describe('parseLatestScheduleSolve', () => {
  it('parses null straight through — "no solve yet" is the designed state, not a failure', () => {
    expect(parseLatestScheduleSolve(null)).toBeNull()
  })

  it('parses a wire row into the domain spelling', () => {
    const parsed = parseLatestScheduleSolve(
      buildScheduleSolveRead({
        status: 'succeeded',
        verdict: 'feasible',
        wall_time_ms: 1200,
        fixtures_placed: 7,
        overrunning: true,
      }),
    )
    expect(parsed).toMatchObject({
      status: 'succeeded',
      verdict: 'feasible',
      wallTimeMs: 1200,
      fixturesPlaced: 7,
      overrunning: true,
      requestedAt: '2026-06-13T09:00:00Z',
    })
  })

  it('refuses a status this client has no words for — it must fail in the queryFn, not blank the strip', () => {
    expect(() =>
      parseLatestScheduleSolve(
        buildScheduleSolveRead({ status: 'exploded' as never }),
      ),
    ).toThrow()
  })

  it('refuses a trigger outside the enum', () => {
    expect(() =>
      parseLatestScheduleSolve(
        buildScheduleSolveRead({ trigger: 'cron' as never }),
      ),
    ).toThrow()
  })

  it('refuses an ABSENT nullable — a payload that dropped a field is not one that means "stage not reached"', () => {
    const { verdict, ...missing } = buildScheduleSolveRead()
    void verdict
    expect(() => parseLatestScheduleSolve(missing)).toThrow()
  })
})

describe('parseScheduleSolve', () => {
  it('parses the 202 ledger row', () => {
    expect(parseScheduleSolve(buildScheduleSolveRead()).id).toBe('solve-1')
  })

  it('refuses null — the POST answers a row, never nothing', () => {
    expect(() => parseScheduleSolve(null)).toThrow()
  })
})

// ----- the strip's sum type ---------------------------------------------------

describe('solveStripState', () => {
  it('maps no-solve to the designed none state', () => {
    expect(solveStripState(null)).toEqual({ kind: 'none' })
  })

  it.each(['queued', 'running'] as const)('maps %s to one solving state', (status) => {
    expect(
      solveStripState(buildScheduleSolve({ status, verdict: null })),
    ).toEqual({ kind: 'solving', trigger: 'manual' })
  })

  it('maps succeeded to its verdict, wall time, finish and trigger', () => {
    expect(
      solveStripState(
        buildScheduleSolve({
          status: 'succeeded',
          verdict: 'optimal',
          trigger: 'go_live',
          wallTimeMs: 850,
          finishedAt: '2026-06-13T09:00:02Z',
        }),
      ),
    ).toEqual({
      kind: 'succeeded',
      verdict: 'optimal',
      overrunning: false,
      wallTimeMs: 850,
      finishedAt: '2026-06-13T09:00:02Z',
      trigger: 'go_live',
    })
  })

  it('carries the overrunning qualifier onto the succeeded arm — the soft-window overrun, not a failure', () => {
    const state = solveStripState(
      buildScheduleSolve({ status: 'succeeded', overrunning: true }),
    )
    expect(state).toMatchObject({ kind: 'succeeded', overrunning: true })
  })

  it('degrades a succeeded row with no verdict to the modest claim (feasible), never a blank', () => {
    const state = solveStripState(buildScheduleSolve({ verdict: null }))
    expect(state).toMatchObject({ kind: 'succeeded', verdict: 'feasible' })
  })

  it('keeps infeasible its OWN designed arm — not folded into failed', () => {
    expect(
      solveStripState(
        buildScheduleSolve({ status: 'infeasible', verdict: 'infeasible' }),
      ),
    ).toMatchObject({ kind: 'infeasible' })
  })

  it('maps failed to its arm, carrying the server error for the detail line', () => {
    expect(
      solveStripState(
        buildScheduleSolve({ status: 'failed', verdict: null, error: 'boom' }),
      ),
    ).toEqual({ kind: 'failed', error: 'boom', trigger: 'manual' })
  })
})

describe('solveInFlight', () => {
  it.each(['queued', 'running'] as const)('is true for %s', (status) => {
    expect(solveInFlight(buildScheduleSolve({ status, verdict: null }))).toBe(true)
  })

  it.each(['succeeded', 'infeasible', 'failed'] as const)(
    'is false for the terminal %s',
    (status) => {
      expect(solveInFlight(buildScheduleSolve({ status }))).toBe(false)
    },
  )

  it('is false for no solve at all', () => {
    expect(solveInFlight(null)).toBe(false)
  })
})

// ----- polling (the function, not timers) --------------------------------------

describe('scheduleRefetchInterval', () => {
  it('polls fast while a solve is in flight, WHATEVER the status — pre-live solves are the point', () => {
    const inFlight = buildScheduleSolve({ status: 'queued', verdict: null })
    expect(scheduleRefetchInterval('draft', inFlight)).toBe(SOLVE_IN_FLIGHT_POLL_MS)
    expect(scheduleRefetchInterval('published', inFlight)).toBe(
      SOLVE_IN_FLIGHT_POLL_MS,
    )
    expect(scheduleRefetchInterval('live', inFlight)).toBe(SOLVE_IN_FLIGHT_POLL_MS)
  })

  it('idles at the ambient clip while live — completions re-plan behind this page\'s back', () => {
    expect(scheduleRefetchInterval('live', null)).toBe(LIVE_POLL_MS)
    expect(scheduleRefetchInterval('live', buildScheduleSolve())).toBe(LIVE_POLL_MS)
  })

  it.each(['draft', 'published', 'archived'] as const)(
    'does not poll a %s tournament with nothing in flight',
    (status) => {
      expect(scheduleRefetchInterval(status, null)).toBe(false)
      expect(scheduleRefetchInterval(status, buildScheduleSolve())).toBe(false)
    },
  )

  it('does not poll before the detail has loaded at all', () => {
    expect(scheduleRefetchInterval(undefined, null)).toBe(false)
  })
})

describe('fmtWallTime', () => {
  it('renders sub-second runs in milliseconds', () => {
    expect(fmtWallTime(850)).toBe('850 ms')
  })

  it('renders second-scale runs to one decimal', () => {
    expect(fmtWallTime(5000)).toBe('5.0s')
    expect(fmtWallTime(1234)).toBe('1.2s')
  })

  it('renders a stage not reached as nothing — the caller drops the clause', () => {
    expect(fmtWallTime(null)).toBeNull()
  })
})

// ----- the run refusals ---------------------------------------------------------

function apiError(status: number, body?: unknown): ApiError {
  return new ApiError(status, 'server prose', 'run the scheduler', body)
}

describe('runSchedulerNotice', () => {
  it('words the coded 422 (no_drawn_events) as the designed "cut a draw first" notice', () => {
    const notice = runSchedulerNotice(
      apiError(422, { detail: { code: 'no_drawn_events', message: 'server prose' } }),
    )
    expect(notice.title).toBe('Nothing to schedule yet')
    expect(notice.description).toContain("Cut at least one event's draw")
  })

  it('does NOT read an uncoded 422 as "cut a draw" — an unknown refusal takes the generic', () => {
    const notice = runSchedulerNotice(
      apiError(422, { detail: [{ loc: ['body'], msg: 'machine prose' }] }),
    )
    expect(notice.title).toBe("Couldn't run the scheduler")
    // Pydantic's machinery never reaches the copy.
    expect(notice.description).not.toContain('machine prose')
  })

  it('words the 403 as ownership, not breakage', () => {
    expect(runSchedulerNotice(apiError(403)).description).toContain(
      'Only the tournament owner',
    )
  })

  it('words the 503 as "nothing was queued, retry is safe"', () => {
    const notice = runSchedulerNotice(apiError(503))
    expect(notice.description).toContain('nothing was queued')
    expect(notice.description).toContain('Try again')
  })

  it('words a network failure (status 0) as the connection, never the server', () => {
    expect(runSchedulerNotice(apiError(0)).title).toBe("Couldn't reach the server")
  })

  it('falls back to the honest generic for anything else — a 500, a non-ApiError', () => {
    expect(runSchedulerNotice(apiError(500)).title).toBe(
      "Couldn't run the scheduler",
    )
    expect(runSchedulerNotice(new Error('x')).title).toBe(
      "Couldn't run the scheduler",
    )
  })
})
