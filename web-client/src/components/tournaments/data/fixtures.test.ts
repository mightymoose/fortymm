import { describe, expect, it } from 'vitest'

import {
  buildFixtureTimeRead,
  buildTournamentFixtureRead,
} from '@/mocks/factories/tournaments/tournament.factory'
import { parseFixtures } from './fixtures'

/** The wire fixture as an untyped blob — which is what it really is when it comes off
 * the network. `parseFixtures` takes `unknown` precisely so a test can hand it one. */
function wire(overrides: Record<string, unknown> = {}): unknown {
  return { ...buildTournamentFixtureRead(), ...overrides }
}

describe('parseFixtures — the happy path', () => {
  it('parses a grouped fixture into the camelCase domain shape', () => {
    expect(
      parseFixtures([
        wire({
          id: 'fx-9',
          group_id: 'grp-a',
          round: 2,
          position: 3,
          entry_a_id: 'entry-5',
          entry_b_id: 'entry-6',
        }),
      ]),
    ).toEqual([
      {
        id: 'fx-9',
        stageId: 's-1',
        groupId: 'grp-a',
        round: 2,
        position: 3,
        entryAId: 'entry-5',
        entryBId: 'entry-6',
        winnerEntryId: null,
        matchId: null,
        matchStatus: null,
        tableId: null,
        scheduledStart: null,
        pinnedAt: null,
        callNotifiedCount: 0,
        completedAt: null,
      },
    ])
  })

  // `[]` is the DESIGNED state of an event whose draw has not been cut (ADR-0786) — not
  // a failure, not a null, not an absence. A parser that treated it as any of those
  // would turn "no draw yet" — the ordinary state of every event before the director
  // cuts one — into an error page.
  it('parses an UNCUT draw to an empty list — the designed empty state, not an error', () => {
    expect(parseFixtures([])).toEqual([])
  })

  it('keeps the order it was given (the wire sends group → round → position)', () => {
    const parsed = parseFixtures([
      wire({ id: 'fx-1', group_id: 'grp-a', round: 1, position: 1 }),
      wire({ id: 'fx-2', group_id: 'grp-a', round: 1, position: 2 }),
      wire({ id: 'fx-3', group_id: 'grp-b', round: 1, position: 1 }),
    ])

    expect(parsed.map((f) => f.id)).toEqual(['fx-1', 'fx-2', 'fx-3'])
  })

  it('carries a TBD side through as null — a side nobody has been drawn into yet', () => {
    const [fixture] = parseFixtures([
      wire({ entry_a_id: null, entry_b_id: null }),
    ])

    expect(fixture.entryAId).toBeNull()
    expect(fixture.entryBId).toBeNull()
  })

  /**
   * `group_id` is `NOT NULL` on the wire since #1484 — every fixture the real server
   * sends now names a real group — so `buildTournamentFixtureRead`'s own TYPE no
   * longer admits a `null` here (that is exactly why `wire()`'s `overrides` param is
   * untyped `Record<string, unknown>` and not `Partial<TournamentFixtureRead>`: this
   * test constructs a payload the wire's own type says can't happen).
   *
   * This parser still tolerates one defensively (`group_id: z.string().nullable()`,
   * `./fixtures`'s own wire schema) rather than tightening to `z.string()` in lock
   * step with the type — the same discipline `entry_a_id`/`winner_entry_id`/etc.
   * follow: a schema that trusted the generated type's `NOT NULL` claim, and a real
   * server that ever regressed (a stale row from before #1484 materialised every
   * fixture's group, say), would surface as a hard parse failure across an entire
   * event's draw rather than one un-grouped fixture rendered in the ungrouped block.
   */
  it('still tolerates a null group_id defensively, even though the wire no longer sends one', () => {
    const [fixture] = parseFixtures([wire({ group_id: null })])

    expect(fixture.groupId).toBeNull()
  })

  it('carries a decided, materialized fixture through — winner, match id, and live status', () => {
    const [fixture] = parseFixtures([
      wire({
        winner_entry_id: 'entry-2',
        match_id: 'm-7',
        match_status: 'completed',
      }),
    ])

    expect(fixture.winnerEntryId).toBe('entry-2')
    expect(fixture.matchId).toBe('m-7')
    expect(fixture.matchStatus).toBe('completed')
  })

  // A placed fixture (ADR-0790): assigned a table and a predicted start. The start
  // now arrives as a `FixtureTimeRead` object (ADR "tournament times are timezone-aware
  // instants") — a UTC `instant` for geometry plus the server-rendered venue-local
  // label + tz abbrev — and is parsed into the camelCase `FixtureTime`, not sliced.
  it('carries a placed fixture through — table id and the predicted start’s instant + venue label', () => {
    const [fixture] = parseFixtures([
      wire({
        table_id: 'table-3',
        scheduled_start: buildFixtureTimeRead('2026-06-09T14:30:00'),
      }),
    ])

    expect(fixture.tableId).toBe('table-3')
    expect(fixture.scheduledStart).toEqual({
      instant: '2026-06-09T14:30:00Z',
      localLabel: '2:30 PM',
      tzAbbrev: 'CDT',
    })
  })

  // A decided fixture's actual completion time (as opposed to `scheduled_start`'s
  // merely predicted one) — the same `FixtureTimeRead` object shape as the other two
  // placement stamps.
  it('carries a decided fixture’s actual completion time through — as an instant + venue label', () => {
    const [fixture] = parseFixtures([
      wire({
        match_status: 'completed',
        completed_at: buildFixtureTimeRead('2026-06-09T15:12:00'),
      }),
    ])

    expect(fixture.completedAt).toEqual({
      instant: '2026-06-09T15:12:00Z',
      localLabel: '3:12 PM',
      tzAbbrev: 'CDT',
    })
  })
})

// THE point of this module. `schema.d.ts` is a compile-time claim about a server we do
// not control (root `CLAUDE.md`), and `api.GET` casts the decoded JSON to it without
// looking — so these payloads are exactly the ones the type system swears cannot arrive,
// and exactly the ones that must fail loudly if they do
// (`.claude/rules/parse-at-boundaries.md`). Each case below would otherwise travel
// inward and surface as an `undefined` in a bracket cell, far from the response that
// carried it.
describe('parseFixtures — the boundary', () => {
  it.each([
    { what: 'a missing round', payload: [{ ...(wire() as object), round: undefined }] },
    { what: 'a round that is a string', payload: [wire({ round: '2' })] },
    { what: 'a fractional round', payload: [wire({ round: 1.5 })] },
    { what: 'a missing position', payload: [{ ...(wire() as object), position: undefined }] },
    { what: 'a group_id of the wrong type', payload: [wire({ group_id: 7 })] },
    { what: 'an id of the wrong type', payload: [wire({ id: 42 })] },
    { what: 'a winner_entry_id of the wrong type', payload: [wire({ winner_entry_id: 3 })] },
    // Absent is NOT null. Null is a fact — "TBD" — and reading an absent key as one
    // would invent a fixture waiting for a player who is never coming.
    { what: 'an absent side', payload: [{ ...(wire() as object), entry_a_id: undefined }] },
    { what: 'an absent match_id', payload: [{ ...(wire() as object), match_id: undefined }] },
    // `match_status` is a fact that moves with `match_id`; absent is not `null`, and a
    // value outside the closed `MatchStatus` set is a status this client cannot render.
    { what: 'an absent match_status', payload: [{ ...(wire() as object), match_status: undefined }] },
    { what: 'a match_status outside the enum', payload: [wire({ match_status: 'archived' })] },
    // Placement (ADR-0790): every null is a fact — unassigned / unscheduled — so an
    // absent key is not a null, and a wrong-typed one is a placement this client cannot read.
    { what: 'an absent table_id', payload: [{ ...(wire() as object), table_id: undefined }] },
    { what: 'a table_id of the wrong type', payload: [wire({ table_id: 7 })] },
    { what: 'an absent scheduled_start', payload: [{ ...(wire() as object), scheduled_start: undefined }] },
    { what: 'a scheduled_start of the wrong type', payload: [wire({ scheduled_start: 7 })] },
    // The pre-ADR naive wall-clock STRING is now a shape this client cannot read: the
    // server ships a `FixtureTimeRead` object, and a bare string would leak inward with
    // no instant to place a bar on and no tz to label (ADR "timezone-aware instants").
    { what: 'a scheduled_start that is a bare naive string (the pre-ADR shape)', payload: [wire({ scheduled_start: '2026-06-09T14:30:00' })] },
    // A FixtureTimeRead missing its tz_abbrev can't label the timezone the ADR requires.
    { what: 'a scheduled_start object missing tz_abbrev', payload: [wire({ scheduled_start: { instant: '2026-06-09T14:30:00Z', local_label: '2:30 PM' } })] },
    { what: 'an absent completed_at', payload: [{ ...(wire() as object), completed_at: undefined }] },
    { what: 'a completed_at of the wrong type', payload: [wire({ completed_at: 7 })] },
    // A draw is a LIST. `null` is not an empty draw: an event with no draw sends `[]`,
    // and a server that sent null would be sending something this client cannot read.
    { what: 'null instead of a list', payload: null },
    { what: 'undefined instead of a list', payload: undefined },
    { what: 'an object instead of a list', payload: wire() },
    { what: 'a list of something that is not a fixture', payload: ['fx-1'] },
  ])('rejects $what', ({ payload }) => {
    expect(() => parseFixtures(payload)).toThrow()
  })

  // One bad fixture poisons the draw, on purpose: the alternative — dropping it and
  // parsing the rest — would silently hand a director a draw with a hole in it, and a
  // draw with a hole in it is worse than an error, because it looks like a draw.
  it('rejects the WHOLE draw when a single fixture is malformed — it does not drop it', () => {
    expect(() =>
      parseFixtures([wire({ id: 'fx-1' }), wire({ id: 'fx-2', round: null })]),
    ).toThrow()
  })
})
