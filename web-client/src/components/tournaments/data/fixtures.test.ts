import { describe, expect, it } from 'vitest'

import { buildTournamentFixtureRead } from '@/mocks/factories/tournaments/tournament.factory'
import { parseFixtures } from './fixtures'

/** The wire fixture as an untyped blob — which is what it really is when it comes off
 * the network. `parseFixtures` takes `unknown` precisely so a test can hand it one. */
function wire(overrides: Record<string, unknown> = {}): unknown {
  return { ...buildTournamentFixtureRead(), ...overrides }
}

describe('parseFixtures — the happy path', () => {
  it('parses a pooled fixture into the camelCase domain shape', () => {
    expect(
      parseFixtures([
        wire({
          id: 'fx-9',
          pool_id: 'p-a',
          round: 2,
          position: 3,
          entry_a_id: 'entry-5',
          entry_b_id: 'entry-6',
        }),
      ]),
    ).toEqual([
      {
        id: 'fx-9',
        poolId: 'p-a',
        round: 2,
        position: 3,
        entryAId: 'entry-5',
        entryBId: 'entry-6',
        winnerEntryId: null,
        matchId: null,
        matchStatus: null,
        tableId: null,
        scheduledStart: null,
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

  it('keeps the order it was given (the wire sends pool → round → position)', () => {
    const parsed = parseFixtures([
      wire({ id: 'fx-1', pool_id: 'p-a', round: 1, position: 1 }),
      wire({ id: 'fx-2', pool_id: 'p-a', round: 1, position: 2 }),
      wire({ id: 'fx-3', pool_id: 'p-b', round: 1, position: 1 }),
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

  // A placed fixture (ADR-0790): assigned a table and a predicted start. Both are
  // carried through as-is — the naive wall-clock start stays the string it arrives as,
  // never coerced to a `Date` at this boundary.
  it('carries a placed fixture through — table id and predicted start', () => {
    const [fixture] = parseFixtures([
      wire({
        table_id: 'table-3',
        scheduled_start: '2026-06-09T14:30:00',
      }),
    ])

    expect(fixture.tableId).toBe('table-3')
    expect(fixture.scheduledStart).toBe('2026-06-09T14:30:00')
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
    { what: 'a pool_id of the wrong type', payload: [wire({ pool_id: 7 })] },
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
