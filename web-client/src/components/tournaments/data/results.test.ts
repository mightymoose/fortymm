import type { components } from '@/api/schema'

import { parseResults } from './results'

type StandingsResultsRead = components['schemas']['StandingsResultsRead']
type FinishesResultsRead = components['schemas']['FinishesResultsRead']
type StandingRowRead = components['schemas']['StandingRowRead']
type FinishRowRead = components['schemas']['FinishRowRead']

/** A wire standings row (`StandingRowRead`), snake_case — the shape the server actually
 * sends, kept next to the parser it feeds. */
function wireRow(overrides: Partial<StandingRowRead> = {}): StandingRowRead {
  return {
    entry_id: 'entry-1',
    rank: 1,
    played: 2,
    wins: 2,
    losses: 0,
    games_won: 4,
    games_lost: 1,
    game_difference: 3,
    ...overrides,
  }
}

/** A complete single-pool `standings` results block off the wire. */
function wireStandings(
  overrides: Partial<StandingsResultsRead> = {},
): StandingsResultsRead {
  return {
    kind: 'standings',
    pools: [{ pool_id: 'p-a', complete: true, rows: [wireRow()] }],
    complete: true,
    champion: 'entry-1',
    ...overrides,
  }
}

/** A wire finish row (`FinishRowRead`), snake_case. */
function wireFinish(overrides: Partial<FinishRowRead> = {}): FinishRowRead {
  return {
    entry_id: 'entry-1',
    position: 1,
    eliminated_in_round: null,
    ...overrides,
  }
}

/** A complete `finishes` results block off the wire — a four-entrant bracket, two semifinal
 * losers tied 3rd. */
function wireFinishes(
  overrides: Partial<FinishesResultsRead> = {},
): FinishesResultsRead {
  return {
    kind: 'finishes',
    finishes: [
      wireFinish({ entry_id: 'entry-1', position: 1, eliminated_in_round: null }),
      wireFinish({ entry_id: 'entry-2', position: 2, eliminated_in_round: 2 }),
      wireFinish({ entry_id: 'entry-3', position: 3, eliminated_in_round: 1 }),
      wireFinish({ entry_id: 'entry-4', position: 3, eliminated_in_round: 1 }),
    ],
    complete: true,
    champion: 'entry-1',
    ...overrides,
  }
}

describe('parseResults', () => {
  it('maps a wire standings block to the camelCase domain shape', () => {
    expect(parseResults(wireStandings())).toEqual({
      kind: 'standings',
      pools: [
        {
          poolId: 'p-a',
          complete: true,
          rows: [
            {
              entryId: 'entry-1',
              rank: 1,
              played: 2,
              wins: 2,
              losses: 0,
              gamesWon: 4,
              gamesLost: 1,
              gameDifference: 3,
            },
          ],
        },
      ],
      complete: true,
      champion: 'entry-1',
    })
  })

  it('maps a wire finishes block to the camelCase domain shape', () => {
    // The single-elimination arm (ADR-0785): the placement list, tag preserved, entries
    // still ids (joined to names later). The two semifinal losers keep the shared position.
    expect(parseResults(wireFinishes())).toEqual({
      kind: 'finishes',
      finishes: [
        { entryId: 'entry-1', position: 1, eliminatedInRound: null },
        { entryId: 'entry-2', position: 2, eliminatedInRound: 2 },
        { entryId: 'entry-3', position: 3, eliminatedInRound: 1 },
        { entryId: 'entry-4', position: 3, eliminatedInRound: 1 },
      ],
      complete: true,
      champion: 'entry-1',
    })
  })

  it('carries the server’s row order through — it does not sort', () => {
    // The order IS the result (ADR-0788); the parse must not reorder. Feed the rows out of
    // rank order and expect them back exactly as sent.
    const parsed = parseResults(
      wireStandings({
        pools: [
          {
            pool_id: 'p-a',
            complete: true,
            rows: [
              wireRow({ entry_id: 'entry-5', rank: 3 }),
              wireRow({ entry_id: 'entry-1', rank: 1 }),
            ],
          },
        ],
      }),
    )

    expect(
      parsed?.kind === 'standings'
        ? parsed.pools[0].rows.map((r) => r.entryId)
        : null,
    ).toEqual(['entry-5', 'entry-1'])
  })

  it('carries the server’s finishes order through — it does not sort', () => {
    // The order IS the result here too (ADR-0785). Feed the finishes out of position order
    // and expect them back exactly as sent.
    const parsed = parseResults(
      wireFinishes({
        finishes: [
          wireFinish({ entry_id: 'entry-3', position: 3, eliminated_in_round: 1 }),
          wireFinish({ entry_id: 'entry-1', position: 1, eliminated_in_round: null }),
        ],
      }),
    )

    expect(
      parsed?.kind === 'finishes'
        ? parsed.finishes.map((f) => f.entryId)
        : null,
    ).toEqual(['entry-3', 'entry-1'])
  })

  it('accepts an explicit null — the designed "no results" state', () => {
    expect(parseResults(null)).toBeNull()
  })

  it('keeps a null champion (a live event) null', () => {
    expect(parseResults(wireStandings({ champion: null }))?.champion).toBeNull()
    expect(parseResults(wireFinishes({ champion: null }))?.champion).toBeNull()
  })

  it('rejects the ABSENT case — results must be present (null), never missing', () => {
    // `.nullable()`, not `.optional()`: a payload that omitted the field is one we cannot
    // tell apart from "no results", so it fails loudly at the boundary.
    expect(() => parseResults(undefined)).toThrow()
  })

  it('rejects an unknown results kind at the boundary', () => {
    // The union is discriminated on `kind`; a shape the client has no arm for (a future
    // draw type's results) fails HERE, before it can leak inward as an untyped blob.
    expect(() =>
      parseResults({ kind: 'ladder', complete: true, champion: null }),
    ).toThrow()
    // …and a payload with NO tag at all.
    expect(() =>
      parseResults({ pools: [], complete: true, champion: null }),
    ).toThrow()
  })

  it('rejects a malformed standings row rather than letting a NaN leak inward', () => {
    expect(() =>
      parseResults(
        wireStandings({
          pools: [
            {
              pool_id: 'p-a',
              complete: true,
              // `wins` as a string is exactly the shape a cast would wave through.
              rows: [{ ...wireRow(), wins: 'two' } as unknown as StandingRowRead],
            },
          ],
        }),
      ),
    ).toThrow()
  })

  it('rejects a malformed finish row rather than letting a NaN leak inward', () => {
    expect(() =>
      parseResults(
        wireFinishes({
          // `position` as a string is exactly the shape a cast would wave through.
          finishes: [{ ...wireFinish(), position: 'first' } as unknown as FinishRowRead],
        }),
      ),
    ).toThrow()
  })
})
