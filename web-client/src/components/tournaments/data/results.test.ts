import type { components } from '@/api/schema'

import { parseResults } from './results'

type StandingsResultsRead = components['schemas']['StandingsResultsRead']
type FinishesResultsRead = components['schemas']['FinishesResultsRead']
type StandingsThenFinishesResultsRead =
  components['schemas']['StandingsThenFinishesResultsRead']
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

/** A complete `standings_then_finishes` results block off the wire (ADR 20260727) — one
 * decided pool and a bracket run to a final. The champion is `entry-2`, who does **not**
 * top the pool: the pool stage only seeds the bracket. */
function wireTwoStage(
  overrides: Partial<StandingsThenFinishesResultsRead> = {},
): StandingsThenFinishesResultsRead {
  return {
    kind: 'standings_then_finishes',
    pools: [
      {
        pool_id: 'p-a',
        complete: true,
        rows: [wireRow(), wireRow({ entry_id: 'entry-2', rank: 2 })],
      },
    ],
    finishes: [
      wireFinish({ entry_id: 'entry-2', position: 1, eliminated_in_round: null }),
      wireFinish({ entry_id: 'entry-1', position: 2, eliminated_in_round: 2 }),
    ],
    complete: true,
    champion: 'entry-2',
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

  it('maps a wire two-stage block to the camelCase domain shape', () => {
    // The third arm (ADR 20260727): BOTH blocks on one value, each the very model its own
    // arm carries, and the tag preserved so `ResultsPanel` can narrow to it. Without this
    // arm the parse THROWS — and since the tournaments list maps every event through it,
    // that takes the whole page down, not one panel.
    expect(parseResults(wireTwoStage())).toEqual({
      kind: 'standings_then_finishes',
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
            {
              entryId: 'entry-2',
              rank: 2,
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
      finishes: [
        { entryId: 'entry-2', position: 1, eliminatedInRound: null },
        { entryId: 'entry-1', position: 2, eliminatedInRound: 2 },
      ],
      complete: true,
      champion: 'entry-2',
    })
  })

  it('keeps a MID-FLIGHT two-stage block’s partial finishes and null champion', () => {
    // Pools decided, final unplayed: `complete: false`, no champion, and a finishes list
    // that starts at position 3 — the shape `ev-shield` is seeded in. Nothing is padded and
    // nothing is invented.
    const parsed = parseResults(
      wireTwoStage({
        complete: false,
        champion: null,
        finishes: [
          wireFinish({ entry_id: 'entry-1', position: 3, eliminated_in_round: 1 }),
          wireFinish({ entry_id: 'entry-2', position: 3, eliminated_in_round: 1 }),
        ],
      }),
    )

    expect(parsed?.complete).toBe(false)
    expect(parsed?.champion).toBeNull()
    expect(
      parsed?.kind === 'standings_then_finishes'
        ? parsed.finishes.map((f) => f.position)
        : null,
    ).toEqual([3, 3])
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

  it('stays STRICT as arms are added — a near-miss tag is still a throw', () => {
    // ⚠️ The guard on the fix for #1227, and the reason it is spelled out separately.
    // Adding the two-stage arm was a widening, and the lazy way to stop a `kind` the client
    // has never met from throwing is to make the union permissive (a passthrough arm, a
    // `.catch()`, a `z.record()` fallback). That would satisfy every OTHER test in this
    // file while silently swallowing real server drift — a future draw type's results would
    // reach the render path as an unrenderable blob instead of failing loudly here.
    //
    // The tags are deliberately a hair away from the real ones: a parser matching on a
    // prefix, or narrowing to "the shape has pools and finishes", waves these through.
    for (const kind of [
      'standings_then_finishes_v2',
      'finishes_then_standings',
      'standings-then-finishes',
      'standings_then_finishes ',
    ]) {
      expect(() => parseResults({ ...wireTwoStage(), kind })).toThrow()
    }
  })

  it('rejects a two-stage block missing a whole stage', () => {
    // Both blocks are required — a two-stage arm that accepted a `finishes`-less payload
    // would hand the panel an undefined stage to render.
    const withoutKey = (key: 'pools' | 'finishes') => {
      const block: Record<string, unknown> = { ...wireTwoStage() }
      delete block[key]
      return block
    }

    expect(() => parseResults(withoutKey('finishes'))).toThrow()
    expect(() => parseResults(withoutKey('pools'))).toThrow()
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
