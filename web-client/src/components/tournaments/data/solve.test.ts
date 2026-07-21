import { describe, expect, it } from 'vitest'

import { ApiError } from '@/api/client'
import { buildScheduleSolveRead } from '@/mocks/factories/tournaments/tournament.factory'

import {
  buildPlayerConflict,
  buildScheduleSolve,
  buildTableConflict,
} from './seed.factory'
import {
  LIVE_POLL_MS,
  SOLVE_IN_FLIGHT_POLL_MS,
  fmtTableTime,
  fmtTables,
  fmtWallTime,
  infeasibilityReasonCopy,
  infeasibilityReasonSchema,
  parseLatestScheduleSolve,
  parseScheduleSolve,
  placementConflictSchema,
  placementConflictSentence,
  runSchedulerNotice,
  scheduleRefetchInterval,
  solveInFlight,
  solveStripState,
  type InfeasibilityReason,
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
      }),
    )
    expect(parsed).toMatchObject({
      status: 'succeeded',
      verdict: 'feasible',
      wallTimeMs: 1200,
      fixturesPlaced: 7,
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

// ----- the infeasibility reasons: parse boundary ------------------------------

describe('infeasibilityReasonSchema (the parse boundary)', () => {
  it('parses pool_has_no_tables into its client arm', () => {
    expect(
      infeasibilityReasonSchema.parse({
        kind: 'pool_has_no_tables',
        pool_name: 'Pool B',
      }),
    ).toEqual({ kind: 'pool_has_no_tables', poolName: 'Pool B' })
  })

  it('parses window_too_short_for_match, mapping snake→camel and keeping best_of narrow', () => {
    expect(
      infeasibilityReasonSchema.parse({
        kind: 'window_too_short_for_match',
        pool_name: 'Pool A',
        window_start: '09:00',
        window_end: '09:20',
        best_of: 5,
        needed_min: 35,
        window_span_min: 20,
      }),
    ).toEqual({
      kind: 'window_too_short_for_match',
      poolName: 'Pool A',
      windowStart: '09:00',
      windowEnd: '09:20',
      bestOf: 5,
      neededMin: 35,
      windowSpanMin: 20,
    })
  })

  it('parses pool_over_capacity', () => {
    expect(
      infeasibilityReasonSchema.parse({
        kind: 'pool_over_capacity',
        pool_name: 'Pool C',
        window_start: '09:00',
        window_end: '13:00',
        required_min: 480,
        capacity_min: 450,
        table_count: 5,
      }),
    ).toEqual({
      kind: 'pool_over_capacity',
      poolName: 'Pool C',
      windowStart: '09:00',
      windowEnd: '13:00',
      requiredMin: 480,
      capacityMin: 450,
      tableCount: 5,
    })
  })

  it('parses no_single_cause (the residual, no pool)', () => {
    expect(
      infeasibilityReasonSchema.parse({
        kind: 'no_single_cause',
        required_min: 360,
        available_min: 480,
      }),
    ).toEqual({ kind: 'no_single_cause', requiredMin: 360, availableMin: 480 })
  })

  it('refuses an arm kind this client has no words for — an unknown reason must fail the parse, not blank the row', () => {
    expect(() =>
      infeasibilityReasonSchema.parse({ kind: 'sunspots', pool_name: 'Pool B' }),
    ).toThrow()
  })

  it('fails the whole solve row when one reason arm is unknown — the boundary rejects, the query fails', () => {
    expect(() =>
      parseLatestScheduleSolve(
        buildScheduleSolveRead({
          status: 'infeasible',
          verdict: 'infeasible',
          infeasibility_reasons: [
            { kind: 'pool_has_no_tables', pool_name: 'Pool B' },
            { kind: 'gremlins' },
          ] as never,
        }),
      ),
    ).toThrow()
  })

  it('carries the reasons through onto the domain row, snake→camel-mapped', () => {
    const parsed = parseLatestScheduleSolve(
      buildScheduleSolveRead({
        status: 'infeasible',
        verdict: 'infeasible',
        infeasibility_reasons: [{ kind: 'pool_has_no_tables', pool_name: 'Pool B' }],
      }),
    )
    expect(parsed?.infeasibilityReasons).toEqual([
      { kind: 'pool_has_no_tables', poolName: 'Pool B' },
    ])
  })

  it('defaults to an empty list off the infeasible path', () => {
    expect(parseLatestScheduleSolve(buildScheduleSolveRead())?.infeasibilityReasons).toEqual([])
  })
})

// ----- the placement conflicts: parse boundary --------------------------------

describe('placementConflictSchema (the parse boundary)', () => {
  it('parses a table_conflict into its client arm, snake→camel, fixtures named by matchup', () => {
    expect(
      placementConflictSchema.parse({
        kind: 'table_conflict',
        table_label: 'Table 1',
        fixtures: [
          { fixture_id: 'fx-a', player_a: 'crafty', player_b: 'spiked' },
          { fixture_id: 'fx-b', player_a: 'dazed', player_b: 'confused' },
        ],
      }),
    ).toEqual({
      kind: 'table_conflict',
      tableLabel: 'Table 1',
      fixtures: [
        { fixtureId: 'fx-a', playerA: 'crafty', playerB: 'spiked' },
        { fixtureId: 'fx-b', playerA: 'dazed', playerB: 'confused' },
      ],
    })
  })

  it('parses a player_conflict into its client arm', () => {
    expect(
      placementConflictSchema.parse({
        kind: 'player_conflict',
        player_name: 'spiked-frigatebird',
        fixtures: [{ fixture_id: 'fx-c', player_a: 'crafty', player_b: 'spiked-frigatebird' }],
      }),
    ).toEqual({
      kind: 'player_conflict',
      playerName: 'spiked-frigatebird',
      fixtures: [{ fixtureId: 'fx-c', playerA: 'crafty', playerB: 'spiked-frigatebird' }],
    })
  })

  it('refuses a conflict kind this client has no words for — it must fail the parse, not blank the warning', () => {
    expect(() =>
      placementConflictSchema.parse({ kind: 'venue_conflict', fixtures: [] }),
    ).toThrow()
  })

  it('carries conflicts onto the domain row — on a SUCCEEDED board (orthogonal to the verdict)', () => {
    const parsed = parseLatestScheduleSolve(
      buildScheduleSolveRead({
        status: 'succeeded',
        verdict: 'feasible',
        placement_conflicts: [
          {
            kind: 'table_conflict',
            table_label: 'Table 1',
            fixtures: [{ fixture_id: 'fx-a', player_a: 'crafty', player_b: 'spiked' }],
          },
        ],
      }),
    )
    expect(parsed?.placementConflicts).toEqual([
      {
        kind: 'table_conflict',
        tableLabel: 'Table 1',
        fixtures: [{ fixtureId: 'fx-a', playerA: 'crafty', playerB: 'spiked' }],
      },
    ])
  })

  it('fails the whole solve row when one conflict arm is unknown — the boundary rejects', () => {
    expect(() =>
      parseLatestScheduleSolve(
        buildScheduleSolveRead({
          placement_conflicts: [{ kind: 'poltergeist', fixtures: [] }] as never,
        }),
      ),
    ).toThrow()
  })

  it('defaults to an empty list on a clean board', () => {
    expect(parseLatestScheduleSolve(buildScheduleSolveRead())?.placementConflicts).toEqual([])
  })

  it('refuses an ABSENT placement_conflicts — an array the API guarantees present cannot be dropped', () => {
    const { placement_conflicts, ...missing } = buildScheduleSolveRead()
    void placement_conflicts
    expect(() => parseLatestScheduleSolve(missing)).toThrow()
  })
})

// ----- the placement conflicts: shared copy -----------------------------------

describe('placementConflictSentence', () => {
  it('names a table conflict as the two matches overlapping on the table', () => {
    expect(placementConflictSentence(buildTableConflict())).toBe(
      'crafty-vs-spiked and dazed-vs-confused overlap on Table 1',
    )
  })

  it('names a player conflict as the two matches overlapping on the human', () => {
    expect(placementConflictSentence(buildPlayerConflict())).toBe(
      'crafty-vs-spiked-frigatebird and spiked-frigatebird-vs-nimble overlap on spiked-frigatebird',
    )
  })

  it('lists three overlapping matches with an Oxford-style join', () => {
    expect(
      placementConflictSentence(
        buildTableConflict({
          fixtures: [
            { fixtureId: 'a', playerA: 'crafty', playerB: 'spiked' },
            { fixtureId: 'b', playerA: 'dazed', playerB: 'confused' },
            { fixtureId: 'c', playerA: 'nimble', playerB: 'quick' },
          ],
        }),
      ),
    ).toBe(
      'crafty-vs-spiked, dazed-vs-confused and nimble-vs-quick overlap on Table 1',
    )
  })
})

// ----- the infeasibility reasons: shared copy ---------------------------------

describe('infeasibilityReasonCopy', () => {
  it('words pool_has_no_tables with the pool name interpolated into both lines', () => {
    expect(
      infeasibilityReasonCopy({ kind: 'pool_has_no_tables', poolName: 'Pool B' }),
    ).toEqual({
      sentence: 'Pool B has no tables assigned.',
      remedy: 'Assign at least one table to Pool B, then run the scheduler again.',
    })
  })

  it('words window_too_short_for_match with the window, format and minutes', () => {
    expect(
      infeasibilityReasonCopy({
        kind: 'window_too_short_for_match',
        poolName: 'Pool A',
        windowStart: '09:00',
        windowEnd: '09:20',
        bestOf: 5,
        neededMin: 35,
        windowSpanMin: 20,
      }),
    ).toEqual({
      sentence:
        "Pool A's 09:00–09:20 window is too short for a best-of-5 match — it needs 35 min but the window is only 20.",
      remedy: "Widen Pool A's window, or use a shorter match format.",
    })
  })

  it('words pool_over_capacity, formatting the minutes as hours and pluralising tables', () => {
    expect(
      infeasibilityReasonCopy({
        kind: 'pool_over_capacity',
        poolName: 'Pool C',
        windowStart: '09:00',
        windowEnd: '13:00',
        requiredMin: 480,
        capacityMin: 450,
        tableCount: 5,
      }),
    ).toEqual({
      sentence:
        "Pool C can't fit all its matches: they need about 8h of table-time, but its 09:00–13:00 window on 5 tables only holds about 7.5h.",
      remedy: 'Add a table to Pool C, widen its window, or trim the field.',
    })
  })

  it('pluralises a single table as "1 table"', () => {
    expect(
      infeasibilityReasonCopy({
        kind: 'pool_over_capacity',
        poolName: 'Pool D',
        windowStart: '09:00',
        windowEnd: '10:15',
        requiredMin: 90,
        capacityMin: 75,
        tableCount: 1,
      }).sentence,
    ).toContain('on 1 table only')
  })

  it('words no_single_cause as a timing conflict that steers away from adding tables', () => {
    const copy = infeasibilityReasonCopy({
      kind: 'no_single_cause',
      requiredMin: 360,
      availableMin: 480,
    })
    expect(copy.sentence).toBe(
      "There's enough total table-time (about 8h available for about 6h of matches), so this is a timing conflict — a player is in too many matches too close together, or tables are shared across overlapping windows.",
    )
    expect(copy.remedy).toContain("adding tables won't help here")
  })

  it('gives each arm a distinct sentence and remedy', () => {
    const arms: InfeasibilityReason[] = [
      { kind: 'pool_has_no_tables', poolName: 'Pool B' },
      {
        kind: 'window_too_short_for_match',
        poolName: 'Pool A',
        windowStart: '09:00',
        windowEnd: '09:20',
        bestOf: 3,
        neededMin: 30,
        windowSpanMin: 20,
      },
      {
        kind: 'pool_over_capacity',
        poolName: 'Pool C',
        windowStart: '09:00',
        windowEnd: '13:00',
        requiredMin: 480,
        capacityMin: 450,
        tableCount: 5,
      },
      { kind: 'no_single_cause', requiredMin: 360, availableMin: 480 },
    ]
    const sentences = arms.map((a) => infeasibilityReasonCopy(a).sentence)
    expect(new Set(sentences).size).toBe(arms.length)
  })
})

describe('fmtTableTime', () => {
  it('renders sub-hour spans in whole minutes, no leading "about"', () => {
    expect(fmtTableTime(45)).toBe('45 min')
  })

  it('renders whole hours without a decimal', () => {
    expect(fmtTableTime(480)).toBe('8h')
  })

  it('renders fractional hours to one decimal (75 min → 1.3h)', () => {
    expect(fmtTableTime(75)).toBe('1.3h')
    expect(fmtTableTime(450)).toBe('7.5h')
  })
})

describe('fmtTables', () => {
  it('pluralises', () => {
    expect(fmtTables(1)).toBe('1 table')
    expect(fmtTables(5)).toBe('5 tables')
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
      wallTimeMs: 850,
      finishedAt: '2026-06-13T09:00:02Z',
      trigger: 'go_live',
    })
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
