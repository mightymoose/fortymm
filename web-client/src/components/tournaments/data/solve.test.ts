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
  it('parses reservation_has_no_tables into its client arm', () => {
    expect(
      infeasibilityReasonSchema.parse({
        kind: 'reservation_has_no_tables',
        reservation_name: 'Reservation B',
        reservation: 'booked',
      }),
    ).toEqual({ kind: 'reservation_has_no_tables', reservationName: 'Reservation B', reservation: 'booked' })
  })

  it('parses window_too_short_for_match, mapping snake→camel and keeping best_of narrow', () => {
    expect(
      infeasibilityReasonSchema.parse({
        kind: 'window_too_short_for_match',
        reservation_name: 'Reservation A',
        reservation: 'booked',
        window_start: '09:00',
        window_end: '09:20',
        best_of: 5,
        needed_min: 35,
        window_span_min: 20,
      }),
    ).toEqual({
      kind: 'window_too_short_for_match',
      reservationName: 'Reservation A',
      reservation: 'booked',
      windowStart: '09:00',
      windowEnd: '09:20',
      bestOf: 5,
      neededMin: 35,
      windowSpanMin: 20,
    })
  })

  it('parses reservation_over_capacity', () => {
    expect(
      infeasibilityReasonSchema.parse({
        kind: 'reservation_over_capacity',
        reservation_name: 'Reservation C',
        reservation: 'booked',
        window_start: '09:00',
        window_end: '13:00',
        required_min: 480,
        capacity_min: 450,
        table_count: 5,
      }),
    ).toEqual({
      kind: 'reservation_over_capacity',
      reservationName: 'Reservation C',
      reservation: 'booked',
      windowStart: '09:00',
      windowEnd: '13:00',
      requiredMin: 480,
      capacityMin: 450,
      tableCount: 5,
      // Absent on the wire (a ledger row written before #1389) reads back as 0.
      groupCount: 0,
    })
  })

  it('parses reservation_over_capacity with its group count (ticket #1389)', () => {
    expect(
      infeasibilityReasonSchema.parse({
        kind: 'reservation_over_capacity',
        reservation_name: 'Reservation C',
        reservation: 'booked',
        window_start: '09:00',
        window_end: '13:00',
        required_min: 480,
        capacity_min: 450,
        table_count: 5,
        group_count: 8,
      }),
    ).toMatchObject({ kind: 'reservation_over_capacity', groupCount: 8 })
  })

  it('parses player_over_subscribed — the one arm that names a human', () => {
    expect(
      infeasibilityReasonSchema.parse({
        kind: 'player_over_subscribed',
        player_name: 'spiked-frigatebird',
        reservation_name: 'Reservation A',
        reservation: 'booked',
        window_start: '09:00',
        window_end: '10:30',
        match_count: 4,
        required_min: 150,
        window_span_min: 90,
      }),
    ).toEqual({
      kind: 'player_over_subscribed',
      playerName: 'spiked-frigatebird',
      reservationName: 'Reservation A',
      reservation: 'booked',
      windowStart: '09:00',
      windowEnd: '10:30',
      matchCount: 4,
      requiredMin: 150,
      windowSpanMin: 90,
    })
  })

  it('carries an event-wide reservation through as `event` — the name is not the fact', () => {
    // The synthetic reservation an ungrouped fixture is placed in (ADR 20260807).
    // Its `reservation_name` is decorated copy ("… (whole venue)"); the *fact* rides in
    // `reservation`, so the copy below never has to read a name to know what it
    // may offer as a remedy.
    expect(
      infeasibilityReasonSchema.parse({
        kind: 'reservation_has_no_tables',
        reservation_name: 'Open Singles (whole venue)',
        reservation: 'event',
      }),
    ).toEqual({
      kind: 'reservation_has_no_tables',
      reservationName: 'Open Singles (whole venue)',
      reservation: 'event',
    })
  })

  it('refuses a reason that names no reservation kind — the remedy would have to guess', () => {
    // Not defaulted to `booked`: guessing here is how a director gets told to add a
    // table to a reservation that already holds every table there is.
    expect(() =>
      infeasibilityReasonSchema.parse({
        kind: 'reservation_has_no_tables',
        reservation_name: 'Reservation B',
      }),
    ).toThrow()
  })

  it('refuses a reservation kind this client has no words for', () => {
    expect(() =>
      infeasibilityReasonSchema.parse({
        kind: 'reservation_has_no_tables',
        reservation_name: 'Reservation B',
        reservation: 'venue',
      }),
    ).toThrow()
  })

  it('parses no_single_cause (the residual, no reservation)', () => {
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
      infeasibilityReasonSchema.parse({ kind: 'sunspots', reservation_name: 'Reservation B' }),
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
            { kind: 'reservation_has_no_tables', reservation_name: 'Reservation B', reservation: 'booked' },
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
        infeasibility_reasons: [
          { kind: 'reservation_has_no_tables', reservation_name: 'Reservation B', reservation: 'booked' },
        ],
      }),
    )
    expect(parsed?.infeasibilityReasons).toEqual([
      { kind: 'reservation_has_no_tables', reservationName: 'Reservation B', reservation: 'booked' },
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
  it('words reservation_has_no_tables with the reservation name interpolated into both lines', () => {
    expect(
      infeasibilityReasonCopy({
        kind: 'reservation_has_no_tables',
        reservationName: 'Reservation B',
        reservation: 'booked',
      }),
    ).toEqual({
      sentence: 'Reservation B has no tables assigned.',
      remedy: 'Assign at least one table to Reservation B, then run the scheduler again.',
    })
  })

  it('words window_too_short_for_match with the window, format and minutes', () => {
    expect(
      infeasibilityReasonCopy({
        kind: 'window_too_short_for_match',
        reservationName: 'Reservation A',
        reservation: 'booked',
        windowStart: '09:00',
        windowEnd: '09:20',
        bestOf: 5,
        neededMin: 35,
        windowSpanMin: 20,
      }),
    ).toEqual({
      sentence:
        "Reservation A's 09:00–09:20 window is too short for a best-of-5 match — it needs 35 min but the window is only 20.",
      remedy: "Widen Reservation A's window, or use a shorter match format.",
    })
  })

  it('words reservation_over_capacity, formatting the minutes as hours and pluralising tables', () => {
    expect(
      infeasibilityReasonCopy({
        kind: 'reservation_over_capacity',
        reservationName: 'Reservation C',
        reservation: 'booked',
        windowStart: '09:00',
        windowEnd: '13:00',
        requiredMin: 480,
        capacityMin: 450,
        tableCount: 5,
        groupCount: 0,
      }),
    ).toEqual({
      sentence:
        "Reservation C can't fit all its matches: they need about 8h of table-time, but its 09:00–13:00 window on 5 tables only holds about 7.5h.",
      remedy: 'Add a table to Reservation C, widen its window, or trim the field.',
    })
  })

  it('pluralises a single table as "1 table"', () => {
    expect(
      infeasibilityReasonCopy({
        kind: 'reservation_over_capacity',
        reservationName: 'Reservation D',
        reservation: 'booked',
        windowStart: '09:00',
        windowEnd: '10:15',
        requiredMin: 90,
        capacityMin: 75,
        tableCount: 1,
        groupCount: 0,
      }).sentence,
    ).toContain('on 1 table only')
  })

  it('words player_over_subscribed by naming the human, the reservation, its window and the match count', () => {
    expect(
      infeasibilityReasonCopy({
        kind: 'player_over_subscribed',
        playerName: 'spiked-frigatebird',
        reservationName: 'Reservation A',
        reservation: 'booked',
        windowStart: '09:00',
        windowEnd: '10:30',
        matchCount: 4,
        requiredMin: 150,
        windowSpanMin: 90,
      }),
    ).toEqual({
      sentence:
        "spiked-frigatebird is in 4 matches inside Reservation A's 09:00–10:30 window — playing one at a time, with a rest between, they need about 2.5h, but the window is only 1.5h long.",
      remedy:
        "Give spiked-frigatebird fewer matches in Reservation A — a smaller reservation, or a shorter match format — or widen its window; adding tables won't help one player.",
    })
  })

  it('never offers "add a table" as the remedy for an over-subscribed player — a table is parallelism, and one human plays one match at a time', () => {
    // THE regression this arm exists to avoid: extra tables let *other* people
    // play at once, and do nothing for one over-subscribed human. The remedies are
    // fewer matches for them in that reservation, or a longer window.
    const copy = infeasibilityReasonCopy({
      kind: 'player_over_subscribed',
      playerName: 'spiked-frigatebird',
      reservationName: 'Reservation A',
      reservation: 'booked',
      windowStart: '09:00',
      windowEnd: '10:30',
      matchCount: 4,
      requiredMin: 150,
      windowSpanMin: 90,
    })
    // Not the `reservation_over_capacity` remedy's advice, in any casing…
    expect(copy.remedy).not.toMatch(/add (a |another |more )?tables?/i)
    // …and the trap is called out explicitly, so a director cannot infer it.
    expect(copy.remedy).toContain("adding tables won't help one player")
    // The remedies that DO work.
    expect(copy.remedy).toContain('fewer matches in Reservation A')
    expect(copy.remedy).toContain('widen its window')
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

  it('stops claiming there is enough table-time when the day needs more than the venue has', () => {
    // Reachable whenever two reservations share tables in overlapping windows —
    // routinely, for a round-robin-then-knockout event, whose knockout is placed
    // over the same tables as its own reservations. Neither is over capacity alone.
    const copy = infeasibilityReasonCopy({
      kind: 'no_single_cause',
      requiredMin: 2220,
      availableMin: 1920,
    })
    expect(copy.sentence).toContain('need about 37h of table-time')
    expect(copy.sentence).toContain('only offers about 32h')
    expect(copy.sentence).not.toContain("There's enough")
    // The opposite of the truth in this state: the venue is short of tables.
    expect(copy.remedy).not.toContain("adding tables won't help")
    expect(copy.remedy).toContain('Add a table')
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
      { kind: 'reservation_has_no_tables', reservationName: 'Reservation B', reservation: 'booked' },
      {
        kind: 'window_too_short_for_match',
        reservationName: 'Reservation A',
        reservation: 'booked',
        windowStart: '09:00',
        windowEnd: '09:20',
        bestOf: 3,
        neededMin: 30,
        windowSpanMin: 20,
      },
      {
        kind: 'reservation_over_capacity',
        reservationName: 'Reservation C',
        reservation: 'booked',
        windowStart: '09:00',
        windowEnd: '13:00',
        requiredMin: 480,
        capacityMin: 450,
        tableCount: 5,
        groupCount: 0,
      },
      {
        kind: 'player_over_subscribed',
        playerName: 'spiked-frigatebird',
        reservationName: 'Reservation A',
        reservation: 'booked',
        windowStart: '09:00',
        windowEnd: '10:30',
        matchCount: 4,
        requiredMin: 150,
        windowSpanMin: 90,
      },
      { kind: 'no_single_cause', requiredMin: 360, availableMin: 480 },
      { kind: 'past_window', date: '2026-07-18' },
    ]
    const sentences = arms.map((a) => infeasibilityReasonCopy(a).sentence)
    expect(new Set(sentences).size).toBe(arms.length)
  })
})

// ----- the infeasibility reasons: the RESERVATION copy, pinned ----------------------
//
// A director reads these four today, and they are asserted in the API's own
// tests too. The event-wide reservation (below) must not have moved a byte of
// them: this block is the regression guard, exact-equality, in one place.

describe('infeasibilityReasonCopy — the reservation copy is unchanged', () => {
  it('pins all four reservation-naming arms, byte for byte', () => {
    expect(
      infeasibilityReasonCopy({
        kind: 'reservation_has_no_tables',
        reservationName: 'Reservation B',
        reservation: 'booked',
      }),
    ).toEqual({
      sentence: 'Reservation B has no tables assigned.',
      remedy: 'Assign at least one table to Reservation B, then run the scheduler again.',
    })

    expect(
      infeasibilityReasonCopy({
        kind: 'window_too_short_for_match',
        reservationName: 'Reservation A',
        reservation: 'booked',
        windowStart: '09:00',
        windowEnd: '09:20',
        bestOf: 5,
        neededMin: 35,
        windowSpanMin: 20,
      }),
    ).toEqual({
      sentence:
        "Reservation A's 09:00–09:20 window is too short for a best-of-5 match — it needs 35 min but the window is only 20.",
      remedy: "Widen Reservation A's window, or use a shorter match format.",
    })

    expect(
      infeasibilityReasonCopy({
        kind: 'reservation_over_capacity',
        reservationName: 'Reservation C',
        reservation: 'booked',
        windowStart: '09:00',
        windowEnd: '13:00',
        requiredMin: 480,
        capacityMin: 450,
        tableCount: 5,
        groupCount: 0,
      }),
    ).toEqual({
      sentence:
        "Reservation C can't fit all its matches: they need about 8h of table-time, but its 09:00–13:00 window on 5 tables only holds about 7.5h.",
      remedy: 'Add a table to Reservation C, widen its window, or trim the field.',
    })

    expect(
      infeasibilityReasonCopy({
        kind: 'player_over_subscribed',
        playerName: 'spiked-frigatebird',
        reservationName: 'Reservation A',
        reservation: 'booked',
        windowStart: '09:00',
        windowEnd: '10:30',
        matchCount: 4,
        requiredMin: 150,
        windowSpanMin: 90,
      }),
    ).toEqual({
      sentence:
        "spiked-frigatebird is in 4 matches inside Reservation A's 09:00–10:30 window — playing one at a time, with a rest between, they need about 2.5h, but the window is only 1.5h long.",
      remedy:
        "Give spiked-frigatebird fewer matches in Reservation A — a smaller reservation, or a shorter match format — or widen its window; adding tables won't help one player.",
    })
  })
})

// ----- the infeasibility reasons: the EVENT-WIDE reservation ------------------
//
// An ungrouped fixture — a bracket, a swiss round, a knockout stage — is placed
// against the event-wide reservation: the event's own window over every table in
// the tournament (ADR 20260807). There is no reservation row behind it, so a remedy must
// name a control the director actually has — the tournament's table list, the
// event's window, the match format, the field size — and must NOT offer a reservation
// verb ("add a table to it", "make it a smaller reservation", "assign a table to it").
// The name it carries is decorated copy, "Open Singles (whole venue)"; the fact
// is `reservation: 'event'`.

const EVENT_RESERVATION_NAME = 'Open Singles (whole venue)'

describe('infeasibilityReasonCopy — the event-wide reservation', () => {
  it('sends reservation_has_no_tables to the TOURNAMENT\'s table list, not to an assignment that does not exist', () => {
    const copy = infeasibilityReasonCopy({
      kind: 'reservation_has_no_tables',
      reservationName: EVENT_RESERVATION_NAME,
      reservation: 'event',
    })
    expect(copy.remedy).toBe(
      'Add at least one table to this tournament, then run the scheduler again.',
    )
    // The reservation verb: there is nothing to assign a table TO.
    expect(copy.remedy).not.toContain('Assign at least one table to')
    expect(copy.remedy).not.toContain(EVENT_RESERVATION_NAME)
  })

  it("sends window_too_short_for_match to the EVENT's own window, not to a reservation's", () => {
    const copy = infeasibilityReasonCopy({
      kind: 'window_too_short_for_match',
      reservationName: EVENT_RESERVATION_NAME,
      reservation: 'event',
      windowStart: '09:00',
      windowEnd: '09:20',
      bestOf: 5,
      neededMin: 35,
      windowSpanMin: 20,
    })
    expect(copy.remedy).toBe(
      "Widen the event's window, or use a shorter match format.",
    )
    // Not "Widen Open Singles (whole venue)'s window" — that control is a reservation's.
    expect(copy.remedy).not.toContain(EVENT_RESERVATION_NAME)
    // The figures are the same honest ones the reservation form reports.
    expect(copy.sentence).toContain('it needs 35 min but the window is only 20')
  })

  it('sends reservation_over_capacity to the tournament, the event window and the field — never "add a table to" the reservation', () => {
    const copy = infeasibilityReasonCopy({
      kind: 'reservation_over_capacity',
      reservationName: EVENT_RESERVATION_NAME,
      reservation: 'event',
      windowStart: '09:00',
      windowEnd: '17:00',
      requiredMin: 600,
      capacityMin: 480,
      tableCount: 4,
      groupCount: 0,
    })
    expect(copy).toEqual({
      sentence:
        "Open Singles (whole venue) can't fit all its matches: they need about 10h of table-time, but the event's 09:00–17:00 window on the tournament's 4 tables only holds about 8h.",
      remedy:
        "Add a table to this tournament, widen the event's window, or trim the field.",
    })
    // The reservation already holds every table there is: adding one TO IT is
    // impossible, and the sentence must not claim the window/tables are its own.
    expect(copy.remedy).not.toContain(`Add a table to ${EVENT_RESERVATION_NAME}`)
    expect(copy.sentence).not.toContain('but its 09:00–17:00 window')
  })

  describe('the group clause on reservation_over_capacity (ticket #1389)', () => {
    const booked = {
      kind: 'reservation_over_capacity' as const,
      reservationName: 'Reservation A',
      reservation: 'booked' as const,
      windowStart: '09:00',
      windowEnd: '13:00',
      requiredMin: 480,
      capacityMin: 450,
      tableCount: 5,
    }
    const eventWide = {
      ...booked,
      reservationName: EVENT_RESERVATION_NAME,
      reservation: 'event' as const,
      windowStart: '09:00',
      windowEnd: '17:00',
      requiredMin: 600,
      capacityMin: 480,
      tableCount: 4,
    }

    it('names how many groups share a booked reservation, and points at adding one', () => {
      const copy = infeasibilityReasonCopy({ ...booked, groupCount: 8 })
      expect(copy.sentence).toBe(
        "Reservation A can't fit all its matches: they need about 8h of table-time, but its 09:00–13:00 window on 5 tables only holds about 7.5h. It holds 8 groups, all competing for the same tables.",
      )
      expect(copy.remedy).toBe(
        'Add a table to Reservation A, widen its window, or trim the field. Adding a reservation spreads the groups across them.',
      )
    })

    it('appends the same clause to the event-wide reservation — both axes fire together', () => {
      // An rr-then-ko event with no reservation: its groups all sit in the
      // event-wide reservation, so `reservation === "event"` AND a count above 1.
      const copy = infeasibilityReasonCopy({ ...eventWide, groupCount: 2 })
      expect(copy.sentence).toBe(
        "Open Singles (whole venue) can't fit all its matches: they need about 10h of table-time, but the event's 09:00–17:00 window on the tournament's 4 tables only holds about 8h. It holds 2 groups, all competing for the same tables.",
      )
      expect(copy.remedy).toBe(
        "Add a table to this tournament, widen the event's window, or trim the field. Adding a reservation spreads the groups across them.",
      )
    })

    it.each([
      ['booked', booked],
      ['event', eventWide],
    ])('renders no group clause at 0 or 1 for a %s reservation', (_kind, base) => {
      // 0: a stale ledger row, or an event-wide reservation holding only a knockout
      // stage. 1: one group, nothing to re-spread. Both read as today's sentence.
      for (const groupCount of [0, 1]) {
        const copy = infeasibilityReasonCopy({ ...base, groupCount })
        expect(copy.sentence).not.toContain('groups')
        expect(copy.remedy).not.toContain('Adding a reservation')
        expect(copy).toEqual(infeasibilityReasonCopy({ ...base, groupCount: 0 }))
      }
    })
  })

  it('offers player_over_subscribed a smaller FIELD and the event\'s window — a "smaller reservation" is not a control here', () => {
    const copy = infeasibilityReasonCopy({
      kind: 'player_over_subscribed',
      playerName: 'spiked-frigatebird',
      reservationName: EVENT_RESERVATION_NAME,
      reservation: 'event',
      windowStart: '09:00',
      windowEnd: '10:30',
      matchCount: 4,
      requiredMin: 150,
      windowSpanMin: 90,
    })
    expect(copy.remedy).toBe(
      "Give spiked-frigatebird fewer matches in this event — a smaller field, or a shorter match format — or widen the event's window; adding tables won't help one player.",
    )
    // The event has no reservation to shrink, and no reservation window to widen.
    expect(copy.remedy).not.toContain('a smaller reservation')
    expect(copy.remedy).not.toContain(EVENT_RESERVATION_NAME)
    // The arm's own rule still holds: a table is parallelism, one human is not.
    expect(copy.remedy).not.toMatch(/add (a |another |more )?tables?/i)
    expect(copy.remedy).toContain("adding tables won't help one player")
  })

  it('leaves the reservation-blind arms alone — they name no reservation to get wrong', () => {
    expect(
      infeasibilityReasonCopy({
        kind: 'no_single_cause',
        requiredMin: 360,
        availableMin: 480,
      }).remedy,
    ).toBe(
      'Trim a field, widen a window, or split the event across days — adding tables won\'t help here.',
    )
    expect(
      infeasibilityReasonCopy({ kind: 'past_window', date: '2026-07-18' }).remedy,
    ).toBe('Move the event to a future date, then run the scheduler again.')
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
