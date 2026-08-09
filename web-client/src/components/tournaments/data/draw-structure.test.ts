// **The vector table IS the contract** (ADR
// 20260808-draw-structure-derivation-runs-on-both-sides-and-shares-its-vectors). The same
// cases are asserted against the Python derivation that guards the API, with identical
// inputs and identical expected numbers, so a change to the maths that lands on one side
// and not the other fails a test.
//
// Three rules keep it transcribable:
//
// 1. **Every vector states all eight inputs.** No defaults builder, no shared base object.
//    A hidden `poolCountMode: 'automatic'` is a guess the Python author would have to
//    make, and DRY is worth less here than being readable as a spec.
// 2. **Every vector states the whole result**, including all three source sentences. One
//    `toEqual` per vector. That is what pins the copy — a sentence asserted nowhere is a
//    sentence free to drift.
// 3. **One loop, no per-case `it` blocks with inline numbers.** A reviewer reads the two
//    tables side by side; they cannot do that if the cases are scattered through
//    assertions.
//
// ## What crosses the language boundary, and what does not
//
// The ADR shares the **numbers**, not the **copy**: the API keeps its own `DegenerateDraw`
// strings (`api/app/draws.py`), and it has no setting rows to write a source sentence
// under. So the Python table asserts a subset of each `expected`, and the split is not
// something a reader should have to infer:
//
// - **Shared, and must match exactly:** `poolCount`, `poolSizes`, `qualifiersPerPool`,
//   `totalQualifiers`, `knockoutBracketSize`, `firstRoundByes`, `poolMatchCount`, the
//   numbers on `disagreement`, and the `kind` of each entry in `impossibleProblems`.
//   Those are the derivation, and a difference in any of them is drift.
// - **Client-only, and deliberately not ported:** `sources` in full (there are no rows on
//   the server), `unevenDistribution` (a notice, not a refusal — the API does not object
//   to unequal pools), and the `title` / `body` on each impossible problem.
//
// The `input` side crosses whole: all eight numbers, unchanged.

import {
  deriveDrawStructure,
  poolLetter,
  type DrawStructure,
  type DrawStructureOptions,
} from './draw-structure'

interface DrawStructureVector {
  /** What the case is about, in the domain's words. */
  name: string
  input: DrawStructureOptions
  expected: DrawStructure
}

/** The shared contract. Mirrored in the Python derivation's own table. */
export const DRAW_STRUCTURE_VECTORS: DrawStructureVector[] = [
  // ---------------------------------------------------------------------------------
  // The reference's own five states, plus the ones it does not draw.
  // ---------------------------------------------------------------------------------

  {
    // The reference's "Nothing set" screen. One pool per reservation row — today's
    // behaviour, kept as the automatic answer.
    name: 'nothing set: 32 players across 4 pool reservations',
    input: {
      previewFieldSize: 32,
      poolReservationCount: 4,
      poolCountMode: 'automatic',
      manualPoolCount: null,
      poolSizeMode: 'automatic',
      manualPoolSize: null,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      poolCount: 4,
      poolSizes: [8, 8, 8, 8],
      qualifiersPerPool: 2,
      totalQualifiers: 8,
      knockoutBracketSize: 8,
      firstRoundByes: 0,
      poolMatchCount: 112,
      sources: {
        poolCount: {
          ownership: 'automatic',
          sentence: "4 pool reservations · today's behaviour",
        },
        poolSize: { ownership: 'automatic', sentence: '32 players ÷ 4 pools' },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 4 pools.',
        },
      },
      disagreement: null,
      unevenDistribution: null,
      impossibleProblems: [],
    },
  },

  {
    // Pool count is the director's, pool size is ours: the balanced split, remainder to
    // the EARLIEST pools.
    name: 'manual pool count only: 40 players across 6 pools',
    input: {
      previewFieldSize: 40,
      poolReservationCount: 4,
      poolCountMode: 'manual',
      manualPoolCount: 6,
      poolSizeMode: 'automatic',
      manualPoolSize: null,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      poolCount: 6,
      poolSizes: [7, 7, 7, 7, 6, 6],
      qualifiersPerPool: 2,
      totalQualifiers: 12,
      knockoutBracketSize: 12,
      firstRoundByes: 4,
      poolMatchCount: 114,
      sources: {
        poolCount: {
          ownership: 'manual',
          sentence: 'You set this. Each pool also gets a reservation.',
        },
        poolSize: { ownership: 'automatic', sentence: '40 players ÷ 6 pools' },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 6 pools.',
        },
      },
      disagreement: null,
      unevenDistribution: [
        { pools: 4, size: 7 },
        { pools: 2, size: 6 },
      ],
      impossibleProblems: [],
    },
  },

  {
    // The other way round: the director's target size derives the count, and 40 divides
    // exactly, so nothing is left over.
    name: 'manual pool size only: 40 players in pools of 5',
    input: {
      previewFieldSize: 40,
      poolReservationCount: 4,
      poolCountMode: 'automatic',
      manualPoolCount: null,
      poolSizeMode: 'manual',
      manualPoolSize: 5,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      poolCount: 8,
      poolSizes: [5, 5, 5, 5, 5, 5, 5, 5],
      qualifiersPerPool: 1,
      totalQualifiers: 8,
      knockoutBracketSize: 8,
      firstRoundByes: 0,
      poolMatchCount: 80,
      sources: {
        poolCount: { ownership: 'automatic', sentence: '40 players ÷ about 5 per pool' },
        poolSize: {
          ownership: 'manual',
          sentence: 'You set the target. We derived the pool count.',
        },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 8 pools.',
        },
      },
      disagreement: null,
      unevenDistribution: null,
      impossibleProblems: [],
    },
  },

  {
    // The reference's "Numbers disagree" screen. BOTH numbers stand — the sizes stay at
    // the six fives the director asked for, and the ten players with nowhere to go are
    // reported rather than seated by moving somebody's number.
    name: 'both manual and disagreeing: 6 pools of 5 seat 30 of a 40 field',
    input: {
      previewFieldSize: 40,
      poolReservationCount: 6,
      poolCountMode: 'manual',
      manualPoolCount: 6,
      poolSizeMode: 'manual',
      manualPoolSize: 5,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      poolCount: 6,
      poolSizes: [5, 5, 5, 5, 5, 5],
      qualifiersPerPool: 2,
      totalQualifiers: 12,
      knockoutBracketSize: 12,
      firstRoundByes: 4,
      poolMatchCount: 60,
      sources: {
        poolCount: {
          ownership: 'manual',
          sentence: 'You set this. Each pool also gets a reservation.',
        },
        poolSize: { ownership: 'manual', sentence: 'You set this.' },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 6 pools.',
        },
      },
      disagreement: {
        poolCount: 6,
        poolSize: 5,
        seats: 30,
        fieldSize: 40,
        direction: 'unseated',
        count: 10,
      },
      unevenDistribution: null,
      // A disagreement is a call for the director, NOT an impossible competition. Every
      // pool here is playable.
      impossibleProblems: [],
    },
  },

  {
    // The disagreement running the other way: more seats than players.
    name: 'both manual, seats to spare: 8 pools of 5 seat 40 of a 30 field',
    input: {
      previewFieldSize: 30,
      poolReservationCount: 8,
      poolCountMode: 'manual',
      manualPoolCount: 8,
      poolSizeMode: 'manual',
      manualPoolSize: 5,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      poolCount: 8,
      poolSizes: [5, 5, 5, 5, 5, 5, 5, 5],
      qualifiersPerPool: 1,
      totalQualifiers: 8,
      knockoutBracketSize: 8,
      firstRoundByes: 0,
      poolMatchCount: 80,
      sources: {
        poolCount: {
          ownership: 'manual',
          sentence: 'You set this. Each pool also gets a reservation.',
        },
        poolSize: { ownership: 'manual', sentence: 'You set this.' },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 8 pools.',
        },
      },
      disagreement: {
        poolCount: 8,
        poolSize: 5,
        seats: 40,
        fieldSize: 30,
        direction: 'empty-seats',
        count: 10,
      },
      unevenDistribution: null,
      impossibleProblems: [],
    },
  },

  {
    // The reference's "Uneven field" screen. Legal, and said out loud — the bigger pools
    // play more matches, and nothing has been silently reshaped.
    name: 'uneven but legal: 22 players across 4 pools',
    input: {
      previewFieldSize: 22,
      poolReservationCount: 4,
      poolCountMode: 'automatic',
      manualPoolCount: null,
      poolSizeMode: 'automatic',
      manualPoolSize: null,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      poolCount: 4,
      poolSizes: [6, 6, 5, 5],
      qualifiersPerPool: 2,
      totalQualifiers: 8,
      knockoutBracketSize: 8,
      firstRoundByes: 0,
      poolMatchCount: 50,
      sources: {
        poolCount: {
          ownership: 'automatic',
          sentence: "4 pool reservations · today's behaviour",
        },
        poolSize: { ownership: 'automatic', sentence: '22 players ÷ 4 pools' },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 4 pools.',
        },
      },
      disagreement: null,
      unevenDistribution: [
        { pools: 2, size: 6 },
        { pools: 2, size: 5 },
      ],
      impossibleProblems: [],
    },
  },

  // ---------------------------------------------------------------------------------
  // The three impossible competitions.
  // ---------------------------------------------------------------------------------

  {
    // The reference's "Field too small" screen — and the ORDERING case. Four pools of one
    // means the pool rule fires, and the automatic two qualifiers out of a pool of one
    // means the qualifier rule would fire too. Only the pool problem is reported: it is
    // the one the director can act on, and the other is its echo.
    name: 'field too small: 8 players across 6 pools reports the pool, not the qualifier',
    input: {
      previewFieldSize: 8,
      poolReservationCount: 6,
      poolCountMode: 'manual',
      manualPoolCount: 6,
      poolSizeMode: 'automatic',
      manualPoolSize: null,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      poolCount: 6,
      poolSizes: [2, 2, 1, 1, 1, 1],
      qualifiersPerPool: 2,
      totalQualifiers: 12,
      knockoutBracketSize: 12,
      firstRoundByes: 4,
      poolMatchCount: 2,
      sources: {
        poolCount: {
          ownership: 'manual',
          sentence: 'You set this. Each pool also gets a reservation.',
        },
        poolSize: { ownership: 'automatic', sentence: '8 players ÷ 6 pools' },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 6 pools.',
        },
      },
      disagreement: null,
      unevenDistribution: [
        { pools: 2, size: 2 },
        { pools: 4, size: 1 },
      ],
      // Pool C, because C is the FIRST pool under two — not the last, and not "four pools".
      impossibleProblems: [
        {
          kind: 'pool',
          title: 'Pool C would have one player',
          body: 'They would have nobody to play. Use fewer pools or raise the player limit.',
        },
      ],
    },
  },

  {
    // One pool taking one qualifier. The pools are fine, so the BRACKET rule is the one
    // that fires — and this is the only vector that catches a missing `max(2, …)` in the
    // byes formula: `2 ^ ceil(log2(max(2, 1))) - 1` is one bye, not none.
    name: 'one-player knockout: 1 pool taking its top 1',
    input: {
      previewFieldSize: 8,
      poolReservationCount: 1,
      poolCountMode: 'manual',
      manualPoolCount: 1,
      poolSizeMode: 'automatic',
      manualPoolSize: null,
      qualifiersMode: 'manual',
      manualQualifiers: 1,
    },
    expected: {
      poolCount: 1,
      poolSizes: [8],
      qualifiersPerPool: 1,
      totalQualifiers: 1,
      knockoutBracketSize: 1,
      firstRoundByes: 1,
      poolMatchCount: 28,
      sources: {
        poolCount: {
          ownership: 'manual',
          sentence: 'You set this. Each pool also gets a reservation.',
        },
        poolSize: { ownership: 'automatic', sentence: '8 players ÷ 1 pools' },
        qualifiers: { ownership: 'manual', sentence: 'You set this.' },
      },
      disagreement: null,
      unevenDistribution: null,
      impossibleProblems: [
        {
          kind: 'bracket',
          title: 'The knockout would have one player',
          body: 'One player has nobody to play. Take more qualifiers or run more pools.',
        },
      ],
    },
  },

  {
    // Three through from a pool that only holds two.
    name: 'too many qualifiers: top 3 from a pool of 2',
    input: {
      previewFieldSize: 10,
      poolReservationCount: 4,
      poolCountMode: 'manual',
      manualPoolCount: 4,
      poolSizeMode: 'automatic',
      manualPoolSize: null,
      qualifiersMode: 'manual',
      manualQualifiers: 3,
    },
    expected: {
      poolCount: 4,
      poolSizes: [3, 3, 2, 2],
      qualifiersPerPool: 3,
      totalQualifiers: 12,
      knockoutBracketSize: 12,
      firstRoundByes: 4,
      poolMatchCount: 8,
      sources: {
        poolCount: {
          ownership: 'manual',
          sentence: 'You set this. Each pool also gets a reservation.',
        },
        poolSize: { ownership: 'automatic', sentence: '10 players ÷ 4 pools' },
        qualifiers: { ownership: 'manual', sentence: 'You set this.' },
      },
      disagreement: null,
      unevenDistribution: [
        { pools: 2, size: 3 },
        { pools: 2, size: 2 },
      ],
      impossibleProblems: [
        {
          kind: 'qualifier',
          // The reference's glyph: `can’t` with a right single quote (`U+2019`).
          title: 'You can’t take 3 qualifiers from a pool of 2',
          body: 'Take 2 or fewer, or make the smallest pool bigger.',
        },
      ],
    },
  },

  {
    // The SECOND ordering case, and the complete set with the one above: a field of one
    // trips the pool rule and the bracket rule at once, and the pool wins. (There is no
    // reachable bracket-over-qualifier case: `bracket < 2` forces one pool taking one,
    // and one qualifier can only exceed a pool of zero, which trips the pool rule first.)
    name: 'ordering: a field of one is a pool problem, not a bracket problem',
    input: {
      previewFieldSize: 1,
      poolReservationCount: 1,
      poolCountMode: 'manual',
      manualPoolCount: 1,
      poolSizeMode: 'automatic',
      manualPoolSize: null,
      qualifiersMode: 'manual',
      manualQualifiers: 1,
    },
    expected: {
      poolCount: 1,
      poolSizes: [1],
      qualifiersPerPool: 1,
      totalQualifiers: 1,
      knockoutBracketSize: 1,
      firstRoundByes: 1,
      poolMatchCount: 0,
      sources: {
        poolCount: {
          ownership: 'manual',
          sentence: 'You set this. Each pool also gets a reservation.',
        },
        poolSize: { ownership: 'automatic', sentence: '1 players ÷ 1 pools' },
        qualifiers: { ownership: 'manual', sentence: 'You set this.' },
      },
      disagreement: null,
      unevenDistribution: null,
      impossibleProblems: [
        {
          kind: 'pool',
          title: 'Pool A would have one player',
          body: 'They would have nobody to play. Use fewer pools or raise the player limit.',
        },
      ],
    },
  },

  {
    // THE GREEDY EDGE. Nine pools, the ninth holding the one player 41 does not divide
    // into eight fives. A balanced split would give `5,5,5,5,5,5,5,4,4` and hide the
    // problem by editing a number the director typed — so the fill stays greedy and the
    // pool of one is reported.
    name: 'greedy fill: 41 players in pools of 5 leaves a pool of one',
    input: {
      previewFieldSize: 41,
      poolReservationCount: 4,
      poolCountMode: 'automatic',
      manualPoolCount: null,
      poolSizeMode: 'manual',
      manualPoolSize: 5,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      poolCount: 9,
      poolSizes: [5, 5, 5, 5, 5, 5, 5, 5, 1],
      qualifiersPerPool: 1,
      totalQualifiers: 9,
      knockoutBracketSize: 9,
      firstRoundByes: 7,
      poolMatchCount: 80,
      sources: {
        poolCount: { ownership: 'automatic', sentence: '41 players ÷ about 5 per pool' },
        poolSize: {
          ownership: 'manual',
          sentence: 'You set the target. We derived the pool count.',
        },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 9 pools.',
        },
      },
      disagreement: null,
      unevenDistribution: [
        { pools: 8, size: 5 },
        { pools: 1, size: 1 },
      ],
      // The ninth pool, so Pool I — past the single-letter cases the earlier vectors pin.
      impossibleProblems: [
        {
          kind: 'pool',
          title: 'Pool I would have one player',
          body: 'They would have nobody to play. Use fewer pools or raise the player limit.',
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------------
  // The edges the reference does not draw.
  // ---------------------------------------------------------------------------------

  {
    // An event with NO cap previews against 16 players. The derivation just takes the
    // number — the honest "16 players because this event has no cap" basis label is the
    // renderer's job — and the pool-size sentence is where the 16 shows up.
    name: 'no cap: the uncapped preview field of 16 players',
    input: {
      previewFieldSize: 16,
      poolReservationCount: 4,
      poolCountMode: 'automatic',
      manualPoolCount: null,
      poolSizeMode: 'automatic',
      manualPoolSize: null,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      poolCount: 4,
      poolSizes: [4, 4, 4, 4],
      qualifiersPerPool: 2,
      totalQualifiers: 8,
      knockoutBracketSize: 8,
      firstRoundByes: 0,
      poolMatchCount: 24,
      sources: {
        poolCount: {
          ownership: 'automatic',
          sentence: "4 pool reservations · today's behaviour",
        },
        poolSize: { ownership: 'automatic', sentence: '16 players ÷ 4 pools' },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 4 pools.',
        },
      },
      disagreement: null,
      unevenDistribution: null,
      impossibleProblems: [],
    },
  },

  {
    // An event with no pool rows yet. The count clamps to one, and the sentence reports
    // the number the derivation USED — `1 pool reservations`, unpluralised, because the
    // sentence explains the division that happened and the reference does not pluralise.
    name: 'no pool reservations yet: the count clamps to one and the sentence says so',
    input: {
      previewFieldSize: 16,
      poolReservationCount: 0,
      poolCountMode: 'automatic',
      manualPoolCount: null,
      poolSizeMode: 'automatic',
      manualPoolSize: null,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      poolCount: 1,
      poolSizes: [16],
      qualifiersPerPool: 8,
      totalQualifiers: 8,
      knockoutBracketSize: 8,
      firstRoundByes: 0,
      poolMatchCount: 120,
      sources: {
        poolCount: {
          ownership: 'automatic',
          sentence: "1 pool reservations · today's behaviour",
        },
        poolSize: { ownership: 'automatic', sentence: '16 players ÷ 1 pools' },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 1 pools.',
        },
      },
      disagreement: null,
      unevenDistribution: null,
      impossibleProblems: [],
    },
  },

  {
    // A director typing a zero into the pool-size box. It clamps to one, and — the same
    // rule as the reservation sentence above — the copy reports the clamped value, not
    // the zero, because that is the division that was actually done.
    name: 'a manual pool size of zero clamps to one, in the maths and in the copy',
    input: {
      previewFieldSize: 3,
      poolReservationCount: 4,
      poolCountMode: 'automatic',
      manualPoolCount: null,
      poolSizeMode: 'manual',
      manualPoolSize: 0,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      poolCount: 3,
      poolSizes: [1, 1, 1],
      qualifiersPerPool: 3,
      totalQualifiers: 9,
      knockoutBracketSize: 9,
      firstRoundByes: 7,
      poolMatchCount: 0,
      sources: {
        poolCount: { ownership: 'automatic', sentence: '3 players ÷ about 1 per pool' },
        poolSize: {
          ownership: 'manual',
          sentence: 'You set the target. We derived the pool count.',
        },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 3 pools.',
        },
      },
      disagreement: null,
      unevenDistribution: null,
      impossibleProblems: [
        {
          kind: 'pool',
          title: 'Pool A would have one player',
          body: 'They would have nobody to play. Use fewer pools or raise the player limit.',
        },
      ],
    },
  },

  {
    // A field of nobody — the state a brand-new event with a zero cap would preview. The
    // pool refusal has a second sentence for it: `no players`, not `one player`.
    name: 'an empty field: the pools have no players at all',
    input: {
      previewFieldSize: 0,
      poolReservationCount: 3,
      poolCountMode: 'automatic',
      manualPoolCount: null,
      poolSizeMode: 'automatic',
      manualPoolSize: null,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      poolCount: 3,
      poolSizes: [0, 0, 0],
      qualifiersPerPool: 3,
      totalQualifiers: 9,
      knockoutBracketSize: 9,
      firstRoundByes: 7,
      poolMatchCount: 0,
      sources: {
        poolCount: {
          ownership: 'automatic',
          sentence: "3 pool reservations · today's behaviour",
        },
        poolSize: { ownership: 'automatic', sentence: '0 players ÷ 3 pools' },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 3 pools.',
        },
      },
      disagreement: null,
      unevenDistribution: null,
      impossibleProblems: [
        {
          kind: 'pool',
          title: 'Pool A would have no players',
          body: 'They would have nobody to play. Use fewer pools or raise the player limit.',
        },
      ],
    },
  },

  {
    // A director who clears every input. The mode still says `manual`, but there is no
    // number, so nothing has been set: the derivation falls back to automatic AND reports
    // the ownership as automatic, so the `Yours` badge can never sit above a sentence
    // saying we worked the number out. Byte-identical to the "nothing set" vector.
    name: 'a manual mode with no number is automatic, badge and all',
    input: {
      previewFieldSize: 32,
      poolReservationCount: 4,
      poolCountMode: 'manual',
      manualPoolCount: null,
      poolSizeMode: 'manual',
      manualPoolSize: null,
      qualifiersMode: 'manual',
      manualQualifiers: null,
    },
    expected: {
      poolCount: 4,
      poolSizes: [8, 8, 8, 8],
      qualifiersPerPool: 2,
      totalQualifiers: 8,
      knockoutBracketSize: 8,
      firstRoundByes: 0,
      poolMatchCount: 112,
      sources: {
        poolCount: {
          ownership: 'automatic',
          sentence: "4 pool reservations · today's behaviour",
        },
        poolSize: { ownership: 'automatic', sentence: '32 players ÷ 4 pools' },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 4 pools.',
        },
      },
      disagreement: null,
      unevenDistribution: null,
      impossibleProblems: [],
    },
  },
]

describe('deriveDrawStructure', () => {
  it.each(DRAW_STRUCTURE_VECTORS)('$name', ({ input, expected }) => {
    expect(deriveDrawStructure(input)).toEqual(expected)
  })
})

describe('poolLetter', () => {
  // The naming the pool refusal and the preview cards both read off. Past Z it keeps
  // naming pools instead of printing punctuation — `String.fromCharCode(65 + 26)` is `[`.
  it('names pools A onwards, and keeps going past Z', () => {
    expect([0, 2, 8, 25, 26, 27, 51, 52].map(poolLetter)).toEqual([
      'A',
      'C',
      'I',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
    ])
  })
})
