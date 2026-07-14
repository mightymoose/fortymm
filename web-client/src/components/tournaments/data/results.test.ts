import type { components } from '@/api/schema'

import { parseResults } from './results'

type EventResultsRead = components['schemas']['EventResultsRead']
type StandingRowRead = components['schemas']['StandingRowRead']

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

/** A complete single-pool results block off the wire. */
function wireResults(overrides: Partial<EventResultsRead> = {}): EventResultsRead {
  return {
    pools: [{ pool_id: 'p-a', complete: true, rows: [wireRow()] }],
    complete: true,
    champion: 'entry-1',
    ...overrides,
  }
}

describe('parseResults', () => {
  it('maps a wire results block to the camelCase domain shape', () => {
    expect(parseResults(wireResults())).toEqual({
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

  it('carries the server’s row order through — it does not sort', () => {
    // The order IS the result (ADR-0788); the parse must not reorder. Feed the rows out of
    // rank order and expect them back exactly as sent.
    const parsed = parseResults(
      wireResults({
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

    expect(parsed?.pools[0].rows.map((r) => r.entryId)).toEqual([
      'entry-5',
      'entry-1',
    ])
  })

  it('accepts an explicit null — the designed "no results" state', () => {
    expect(parseResults(null)).toBeNull()
  })

  it('keeps a null champion (a live or multi-pool event) null', () => {
    expect(parseResults(wireResults({ champion: null }))?.champion).toBeNull()
  })

  it('rejects the ABSENT case — results must be present (null), never missing', () => {
    // `.nullable()`, not `.optional()`: a payload that omitted the field is one we cannot
    // tell apart from "no results", so it fails loudly at the boundary.
    expect(() => parseResults(undefined)).toThrow()
  })

  it('rejects a malformed row rather than letting a NaN leak inward', () => {
    expect(() =>
      parseResults(
        wireResults({
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
})
