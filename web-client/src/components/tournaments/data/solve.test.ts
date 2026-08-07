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
  type ConflictFixture,
  type InfeasibilityReason,
} from './solve'

/** A conflict core's fixtures, in the domain spelling — the same `ConflictFixture`
 * shape a placement conflict carries, which is the point of the shared type. */
const CORE_FIXTURES: ConflictFixture[] = [
  { fixtureId: 'fx-1', playerA: 'crafty-otter', playerB: 'spiked-frigatebird' },
  { fixtureId: 'fx-2', playerA: 'dazed-marmot', playerB: 'wily-heron' },
  { fixtureId: 'fx-3', playerA: 'mellow-quokka', playerB: 'brisk-tapir' },
]

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

  it('parses player_over_subscribed — the one arm that names a human', () => {
    expect(
      infeasibilityReasonSchema.parse({
        kind: 'player_over_subscribed',
        player_name: 'spiked-frigatebird',
        pool_name: 'Pool A',
        window_start: '09:00',
        window_end: '10:30',
        match_count: 4,
        required_min: 150,
        window_span_min: 90,
      }),
    ).toEqual({
      kind: 'player_over_subscribed',
      playerName: 'spiked-frigatebird',
      poolName: 'Pool A',
      windowStart: '09:00',
      windowEnd: '10:30',
      matchCount: 4,
      requiredMin: 150,
      windowSpanMin: 90,
    })
  })

  it('parses unplaceable_fixtures — the conflict core, through the SAME fixture shape a placement conflict uses', () => {
    expect(
      infeasibilityReasonSchema.parse({
        kind: 'unplaceable_fixtures',
        fixtures: [
          { fixture_id: 'fx-1', player_a: 'crafty-otter', player_b: 'spiked-frigatebird' },
          { fixture_id: 'fx-2', player_a: 'dazed-marmot', player_b: 'wily-heron' },
        ],
      }),
    ).toEqual({
      kind: 'unplaceable_fixtures',
      fixtures: [
        { fixtureId: 'fx-1', playerA: 'crafty-otter', playerB: 'spiked-frigatebird' },
        { fixtureId: 'fx-2', playerA: 'dazed-marmot', playerB: 'wily-heron' },
      ],
    })
  })

  it('refuses an unplaceable_fixtures arm whose fixtures are malformed — a half-named match must fail the parse, not render half a matchup', () => {
    expect(() =>
      infeasibilityReasonSchema.parse({
        kind: 'unplaceable_fixtures',
        fixtures: [{ fixture_id: 'fx-1', player_a: 'crafty-otter' }],
      }),
    ).toThrow()
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

  it('parses past_window, carrying the offending venue-local date straight through', () => {
    expect(
      infeasibilityReasonSchema.parse({ kind: 'past_window', date: '2026-07-18' }),
    ).toEqual({ kind: 'past_window', date: '2026-07-18' })
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

  it('words player_over_subscribed by naming the human, the pool, its window and the match count', () => {
    expect(
      infeasibilityReasonCopy({
        kind: 'player_over_subscribed',
        playerName: 'spiked-frigatebird',
        poolName: 'Pool A',
        windowStart: '09:00',
        windowEnd: '10:30',
        matchCount: 4,
        requiredMin: 150,
        windowSpanMin: 90,
      }),
    ).toEqual({
      sentence:
        "spiked-frigatebird is in 4 matches inside Pool A's 09:00–10:30 window — playing one at a time, with a rest between, they need about 2.5h, but the window is only 1.5h long.",
      remedy:
        "Give spiked-frigatebird fewer matches in Pool A — a smaller pool, or a shorter match format — or widen its window; adding tables won't help one player.",
    })
  })

  it('never offers "add a table" as the remedy for an over-subscribed player — a table is parallelism, and one human plays one match at a time', () => {
    // THE regression this arm exists to avoid: extra tables let *other* people
    // play at once, and do nothing for one over-subscribed human. The remedies are
    // fewer matches for them in that pool, or a longer window.
    const copy = infeasibilityReasonCopy({
      kind: 'player_over_subscribed',
      playerName: 'spiked-frigatebird',
      poolName: 'Pool A',
      windowStart: '09:00',
      windowEnd: '10:30',
      matchCount: 4,
      requiredMin: 150,
      windowSpanMin: 90,
    })
    // Not the `pool_over_capacity` remedy's advice, in any casing…
    expect(copy.remedy).not.toMatch(/add (a |another |more )?tables?/i)
    // …and the trap is called out explicitly, so a director cannot infer it.
    expect(copy.remedy).toContain("adding tables won't help one player")
    // The remedies that DO work.
    expect(copy.remedy).toContain('fewer matches in Pool A')
    expect(copy.remedy).toContain('widen its window')
  })

  it('words unplaceable_fixtures by naming every match, by who is playing whom', () => {
    expect(
      infeasibilityReasonCopy({
        kind: 'unplaceable_fixtures',
        fixtures: CORE_FIXTURES,
      }),
    ).toEqual({
      sentence:
        "3 matches couldn't all be placed: crafty-otter-vs-spiked-frigatebird, dazed-marmot-vs-wily-heron and mellow-quokka-vs-brisk-tapir — the rest of the day fits once they're out of it, though they aren't necessarily the smallest set to change.",
      remedy:
        "Trim one of these matches from the field, widen its pool's window, or split the event across days — adding tables won't help here.",
    })
  })

  it('never claims the conflict core is minimal — the diagnostic is a capped optimization, so "these could not all be placed" is the strongest true sentence', () => {
    // THE regression this arm exists to avoid (ADR "the conflict core is a second,
    // max-placed solve", decision 4; CONTEXT.md "Conflict core"). The API extracts
    // this set from an optimization under a time cap and carries NO proven/partial
    // flag, so the copy has to be true whether the solver proved optimality or ran
    // out of time. Anything that promises a minimum is a lie in the second case.
    for (const fixtures of [CORE_FIXTURES, [CORE_FIXTURES[0]!]]) {
      const copy = infeasibilityReasonCopy({ kind: 'unplaceable_fixtures', fixtures })
      const said = `${copy.sentence} ${copy.remedy}`
      // No minimality vocabulary, in any casing…
      expect(said).not.toMatch(/\bminimum\b|\bminimal\b|\bfewest\b/i)
      expect(said).not.toMatch(/\b(is|are) the smallest\b/i)
      // …no imperative that turns the set into an instruction…
      expect(said).not.toMatch(/must (remove|drop|delete|cut|take out)/i)
      expect(said).not.toMatch(/exactly these|these exact|remove all of these/i)
      // …and the hedge is on screen, not merely absent-by-luck: a future edit that
      // drops it reds here.
      expect(copy.sentence).toMatch(/aren't necessarily|isn't necessarily/)
    }
    // The sanctioned phrasing, verbatim from CONTEXT.md's "Conflict core".
    expect(
      infeasibilityReasonCopy({ kind: 'unplaceable_fixtures', fixtures: CORE_FIXTURES })
        .sentence,
    ).toContain("couldn't all be placed")
  })

  it('never steers the director toward adding tables for a conflict core — capacity already passed, so this is arrangement, not tables', () => {
    // Same trap as `no_single_cause`, for the same reason: this arm is only
    // reached once every capacity pre-check passed, so there IS table-time to
    // spare. The remedy stays consistent with the residual's wording.
    const copy = infeasibilityReasonCopy({
      kind: 'unplaceable_fixtures',
      fixtures: CORE_FIXTURES,
    })
    expect(copy.remedy).not.toMatch(/add (a |another |more )?tables?/i)
    expect(copy.remedy).toContain("adding tables won't help here")
  })

  it('names EVERY match in a long core — nothing is elided behind an "and N more"', () => {
    // A drop set a director can only half-see is not actionable, and a truncated
    // list would read as *the* set — the one claim this arm may not make.
    const many = Array.from({ length: 7 }, (_, i) => ({
      fixtureId: `fx-${i}`,
      playerA: `player-a${i}`,
      playerB: `player-b${i}`,
    }))
    const { sentence } = infeasibilityReasonCopy({
      kind: 'unplaceable_fixtures',
      fixtures: many,
    })
    for (const f of many) {
      expect(sentence).toContain(`${f.playerA}-vs-${f.playerB}`)
    }
    expect(sentence).not.toMatch(/\bmore\b|…|\.\.\./)
    expect(sentence).toContain("7 matches couldn't all be placed")
  })

  it('words a one-match core in the singular — the sentence stays grammatical at the smallest core', () => {
    const copy = infeasibilityReasonCopy({
      kind: 'unplaceable_fixtures',
      fixtures: [CORE_FIXTURES[0]!],
    })
    expect(copy.sentence).toBe(
      "1 match couldn't be placed: crafty-otter-vs-spiked-frigatebird — the rest of the day fits without it, though freeing it up isn't necessarily the only way to make the day work.",
    )
    expect(copy.remedy).toBe(
      "Trim this match from the field, widen its pool's window, or split the event across days — adding tables won't help here.",
    )
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

  it('words past_window as a dated "in the past" sentence, remedy "move the date"', () => {
    expect(
      infeasibilityReasonCopy({ kind: 'past_window', date: '2026-07-18' }),
    ).toEqual({
      sentence: 'This event is dated in the past (Jul 18, 2026), so it can\'t be scheduled.',
      remedy: 'Move the event to a future date, then run the scheduler again.',
    })
  })

  it('formats the venue-local date without a timezone shift — the day named is the day sent', () => {
    // A plain `YYYY-MM-DD` must render as that calendar day whatever the runner's
    // timezone (fmtDate parses to local midnight, never a UTC instant).
    expect(
      infeasibilityReasonCopy({ kind: 'past_window', date: '2026-01-01' }).sentence,
    ).toContain('Jan 1, 2026')
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
      {
        kind: 'player_over_subscribed',
        playerName: 'spiked-frigatebird',
        poolName: 'Pool A',
        windowStart: '09:00',
        windowEnd: '10:30',
        matchCount: 4,
        requiredMin: 150,
        windowSpanMin: 90,
      },
      { kind: 'unplaceable_fixtures', fixtures: CORE_FIXTURES },
      { kind: 'no_single_cause', requiredMin: 360, availableMin: 480 },
      { kind: 'past_window', date: '2026-07-18' },
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

  it('threads the resolved reasons — including a past_window arm — onto the infeasible arm', () => {
    const state = solveStripState(
      buildScheduleSolve({
        status: 'infeasible',
        verdict: 'infeasible',
        infeasibilityReasons: [{ kind: 'past_window', date: '2026-07-18' }],
      }),
    )
    expect(state).toMatchObject({
      kind: 'infeasible',
      reasons: [{ kind: 'past_window', date: '2026-07-18' }],
    })
  })

  it('carries an empty reasons list for an infeasibility with no resolved cause', () => {
    const state = solveStripState(
      buildScheduleSolve({ status: 'infeasible', verdict: 'infeasible' }),
    )
    expect(state).toMatchObject({ kind: 'infeasible', reasons: [] })
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
