// **The vector table IS the contract** (ADR
// 20260808-draw-structure-derivation-runs-on-both-sides-and-shares-its-vectors). The same
// cases are asserted against the Python derivation that guards the API, with identical
// inputs and identical expected numbers, so a change to the maths that lands on one side
// and not the other fails a test.
//
// Three rules keep it transcribable:
//
// 1. **Every vector states all eight inputs.** No defaults builder, no shared base object.
//    A hidden `groupCountMode: 'automatic'` is a guess the Python author would have to
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
// - **Shared, and must match exactly:** `groupCount`, `groupSizes`, `qualifiersPerGroup`,
//   `totalQualifiers`, `knockoutBracketSize`, `firstRoundByes`, `groupMatchCount`, the
//   numbers on `disagreement`, and the `kind` of each entry in `impossibleProblems`.
//   Those are the derivation, and a difference in any of them is drift.
// - **Client-only, and deliberately not ported:** `sources` in full (there are no rows on
//   the server), `unevenDistribution` (a notice, not a refusal — the API does not object
//   to unequal groups), and the `title` / `body` on each impossible problem.
//
// The `input` side crosses whole: all eight numbers, unchanged.

import {
  deriveDrawStructure,
  groupLetter,
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
    // The reference's "Nothing set" screen. One group per reservation row — today's
    // behaviour, kept as the automatic answer.
    name: 'nothing set: 32 players across 4 reservations',
    input: {
      previewFieldSize: 32,
      reservationCount: 4,
      groupCountMode: 'automatic',
      manualGroupCount: null,
      groupSizeMode: 'automatic',
      manualGroupSize: null,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      groupCount: 4,
      groupSizes: [8, 8, 8, 8],
      qualifiersPerGroup: 2,
      totalQualifiers: 8,
      knockoutBracketSize: 8,
      firstRoundByes: 0,
      groupMatchCount: 112,
      sources: {
        groupCount: {
          ownership: 'automatic',
          sentence: "4 reservations · today's behaviour",
        },
        groupSize: { ownership: 'automatic', sentence: '32 players ÷ 4 groups' },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 4 groups.',
        },
      },
      disagreement: null,
      unevenDistribution: null,
      impossibleProblems: [],
    },
  },

  {
    // Group count is the director's, group size is ours: the balanced split, remainder to
    // the EARLIEST groups.
    name: 'manual group count only: 40 players across 6 groups',
    input: {
      previewFieldSize: 40,
      reservationCount: 4,
      groupCountMode: 'manual',
      manualGroupCount: 6,
      groupSizeMode: 'automatic',
      manualGroupSize: null,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      groupCount: 6,
      groupSizes: [7, 7, 7, 7, 6, 6],
      qualifiersPerGroup: 2,
      totalQualifiers: 12,
      knockoutBracketSize: 12,
      firstRoundByes: 4,
      groupMatchCount: 114,
      sources: {
        groupCount: {
          ownership: 'manual',
          sentence: 'You set this. Each group also gets a reservation.',
        },
        groupSize: { ownership: 'automatic', sentence: '40 players ÷ 6 groups' },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 6 groups.',
        },
      },
      disagreement: null,
      unevenDistribution: [
        { groups: 4, size: 7 },
        { groups: 2, size: 6 },
      ],
      impossibleProblems: [],
    },
  },

  {
    // The other way round: the director's target size derives the count, and 40 divides
    // exactly, so nothing is left over.
    name: 'manual group size only: 40 players in groups of 5',
    input: {
      previewFieldSize: 40,
      reservationCount: 4,
      groupCountMode: 'automatic',
      manualGroupCount: null,
      groupSizeMode: 'manual',
      manualGroupSize: 5,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      groupCount: 8,
      groupSizes: [5, 5, 5, 5, 5, 5, 5, 5],
      qualifiersPerGroup: 1,
      totalQualifiers: 8,
      knockoutBracketSize: 8,
      firstRoundByes: 0,
      groupMatchCount: 80,
      sources: {
        groupCount: { ownership: 'automatic', sentence: '40 players ÷ about 5 per group' },
        groupSize: {
          ownership: 'manual',
          sentence: 'You set the target. We derived the group count.',
        },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 8 groups.',
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
    name: 'both manual and disagreeing: 6 groups of 5 seat 30 of a 40 field',
    input: {
      previewFieldSize: 40,
      reservationCount: 6,
      groupCountMode: 'manual',
      manualGroupCount: 6,
      groupSizeMode: 'manual',
      manualGroupSize: 5,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      groupCount: 6,
      groupSizes: [5, 5, 5, 5, 5, 5],
      qualifiersPerGroup: 2,
      totalQualifiers: 12,
      knockoutBracketSize: 12,
      firstRoundByes: 4,
      groupMatchCount: 60,
      sources: {
        groupCount: {
          ownership: 'manual',
          sentence: 'You set this. Each group also gets a reservation.',
        },
        groupSize: { ownership: 'manual', sentence: 'You set this.' },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 6 groups.',
        },
      },
      disagreement: {
        groupCount: 6,
        groupSize: 5,
        seats: 30,
        fieldSize: 40,
        direction: 'unseated',
        count: 10,
      },
      unevenDistribution: null,
      // A disagreement is a call for the director, NOT an impossible competition. Every
      // group here is playable.
      impossibleProblems: [],
    },
  },

  {
    // The disagreement running the other way: more seats than players.
    name: 'both manual, seats to spare: 8 groups of 5 seat 40 of a 30 field',
    input: {
      previewFieldSize: 30,
      reservationCount: 8,
      groupCountMode: 'manual',
      manualGroupCount: 8,
      groupSizeMode: 'manual',
      manualGroupSize: 5,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      groupCount: 8,
      groupSizes: [5, 5, 5, 5, 5, 5, 5, 5],
      qualifiersPerGroup: 1,
      totalQualifiers: 8,
      knockoutBracketSize: 8,
      firstRoundByes: 0,
      groupMatchCount: 80,
      sources: {
        groupCount: {
          ownership: 'manual',
          sentence: 'You set this. Each group also gets a reservation.',
        },
        groupSize: { ownership: 'manual', sentence: 'You set this.' },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 8 groups.',
        },
      },
      disagreement: {
        groupCount: 8,
        groupSize: 5,
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
    // The reference's "Uneven field" screen. Legal, and said out loud — the bigger groups
    // play more matches, and nothing has been silently reshaped.
    name: 'uneven but legal: 22 players across 4 groups',
    input: {
      previewFieldSize: 22,
      reservationCount: 4,
      groupCountMode: 'automatic',
      manualGroupCount: null,
      groupSizeMode: 'automatic',
      manualGroupSize: null,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      groupCount: 4,
      groupSizes: [6, 6, 5, 5],
      qualifiersPerGroup: 2,
      totalQualifiers: 8,
      knockoutBracketSize: 8,
      firstRoundByes: 0,
      groupMatchCount: 50,
      sources: {
        groupCount: {
          ownership: 'automatic',
          sentence: "4 reservations · today's behaviour",
        },
        groupSize: { ownership: 'automatic', sentence: '22 players ÷ 4 groups' },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 4 groups.',
        },
      },
      disagreement: null,
      unevenDistribution: [
        { groups: 2, size: 6 },
        { groups: 2, size: 5 },
      ],
      impossibleProblems: [],
    },
  },

  // ---------------------------------------------------------------------------------
  // The three impossible competitions.
  // ---------------------------------------------------------------------------------

  {
    // The reference's "Field too small" screen — and the ORDERING case. Four groups of one
    // means the group rule fires, and the automatic two qualifiers out of a group of one
    // means the qualifier rule would fire too. Only the group problem is reported: it is
    // the one the director can act on, and the other is its echo.
    name: 'field too small: 8 players across 6 groups reports the group, not the qualifier',
    input: {
      previewFieldSize: 8,
      reservationCount: 6,
      groupCountMode: 'manual',
      manualGroupCount: 6,
      groupSizeMode: 'automatic',
      manualGroupSize: null,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      groupCount: 6,
      groupSizes: [2, 2, 1, 1, 1, 1],
      qualifiersPerGroup: 2,
      totalQualifiers: 12,
      knockoutBracketSize: 12,
      firstRoundByes: 4,
      groupMatchCount: 2,
      sources: {
        groupCount: {
          ownership: 'manual',
          sentence: 'You set this. Each group also gets a reservation.',
        },
        groupSize: { ownership: 'automatic', sentence: '8 players ÷ 6 groups' },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 6 groups.',
        },
      },
      disagreement: null,
      unevenDistribution: [
        { groups: 2, size: 2 },
        { groups: 4, size: 1 },
      ],
      // Group C, because C is the FIRST group under two — not the last, and not "four groups".
      impossibleProblems: [
        {
          kind: 'group',
          title: 'Group C would have one player',
          body: 'They would have nobody to play. Use fewer groups or raise the player limit.',
        },
      ],
    },
  },

  {
    // One group taking one qualifier. The groups are fine, so the BRACKET rule is the one
    // that fires — and this is the only vector that catches a missing `max(2, …)` in the
    // byes formula: `2 ^ ceil(log2(max(2, 1))) - 1` is one bye, not none.
    name: 'one-player knockout: 1 group taking its top 1',
    input: {
      previewFieldSize: 8,
      reservationCount: 1,
      groupCountMode: 'manual',
      manualGroupCount: 1,
      groupSizeMode: 'automatic',
      manualGroupSize: null,
      qualifiersMode: 'manual',
      manualQualifiers: 1,
    },
    expected: {
      groupCount: 1,
      groupSizes: [8],
      qualifiersPerGroup: 1,
      totalQualifiers: 1,
      knockoutBracketSize: 1,
      firstRoundByes: 1,
      groupMatchCount: 28,
      sources: {
        groupCount: {
          ownership: 'manual',
          sentence: 'You set this. Each group also gets a reservation.',
        },
        groupSize: { ownership: 'automatic', sentence: '8 players ÷ 1 groups' },
        qualifiers: { ownership: 'manual', sentence: 'You set this.' },
      },
      disagreement: null,
      unevenDistribution: null,
      impossibleProblems: [
        {
          kind: 'bracket',
          title: 'The knockout would have one player',
          body: 'One player has nobody to play. Take more qualifiers or run more groups.',
        },
      ],
    },
  },

  {
    // Three through from a group that only holds two.
    name: 'too many qualifiers: top 3 from a group of 2',
    input: {
      previewFieldSize: 10,
      reservationCount: 4,
      groupCountMode: 'manual',
      manualGroupCount: 4,
      groupSizeMode: 'automatic',
      manualGroupSize: null,
      qualifiersMode: 'manual',
      manualQualifiers: 3,
    },
    expected: {
      groupCount: 4,
      groupSizes: [3, 3, 2, 2],
      qualifiersPerGroup: 3,
      totalQualifiers: 12,
      knockoutBracketSize: 12,
      firstRoundByes: 4,
      groupMatchCount: 8,
      sources: {
        groupCount: {
          ownership: 'manual',
          sentence: 'You set this. Each group also gets a reservation.',
        },
        groupSize: { ownership: 'automatic', sentence: '10 players ÷ 4 groups' },
        qualifiers: { ownership: 'manual', sentence: 'You set this.' },
      },
      disagreement: null,
      unevenDistribution: [
        { groups: 2, size: 3 },
        { groups: 2, size: 2 },
      ],
      impossibleProblems: [
        {
          kind: 'qualifier',
          title: "You can't take 3 qualifiers from a group of 2",
          body: 'Take 2 or fewer, or make the smallest group bigger.',
        },
      ],
    },
  },

  {
    // The SECOND ordering case, and the complete set with the one above: a field of one
    // trips the group rule and the bracket rule at once, and the group wins. (There is no
    // reachable bracket-over-qualifier case: `bracket < 2` forces one group taking one,
    // and one qualifier can only exceed a group of zero, which trips the group rule first.)
    name: 'ordering: a field of one is a group problem, not a bracket problem',
    input: {
      previewFieldSize: 1,
      reservationCount: 1,
      groupCountMode: 'manual',
      manualGroupCount: 1,
      groupSizeMode: 'automatic',
      manualGroupSize: null,
      qualifiersMode: 'manual',
      manualQualifiers: 1,
    },
    expected: {
      groupCount: 1,
      groupSizes: [1],
      qualifiersPerGroup: 1,
      totalQualifiers: 1,
      knockoutBracketSize: 1,
      firstRoundByes: 1,
      groupMatchCount: 0,
      sources: {
        groupCount: {
          ownership: 'manual',
          sentence: 'You set this. Each group also gets a reservation.',
        },
        groupSize: { ownership: 'automatic', sentence: '1 players ÷ 1 groups' },
        qualifiers: { ownership: 'manual', sentence: 'You set this.' },
      },
      disagreement: null,
      unevenDistribution: null,
      impossibleProblems: [
        {
          kind: 'group',
          title: 'Group A would have one player',
          body: 'They would have nobody to play. Use fewer groups or raise the player limit.',
        },
      ],
    },
  },

  {
    // THE GREEDY EDGE. Nine groups, the ninth holding the one player 41 does not divide
    // into eight fives. A balanced split would give `5,5,5,5,5,5,5,4,4` and hide the
    // problem by editing a number the director typed — so the fill stays greedy and the
    // group of one is reported.
    name: 'greedy fill: 41 players in groups of 5 leaves a group of one',
    input: {
      previewFieldSize: 41,
      reservationCount: 4,
      groupCountMode: 'automatic',
      manualGroupCount: null,
      groupSizeMode: 'manual',
      manualGroupSize: 5,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      groupCount: 9,
      groupSizes: [5, 5, 5, 5, 5, 5, 5, 5, 1],
      qualifiersPerGroup: 1,
      totalQualifiers: 9,
      knockoutBracketSize: 9,
      firstRoundByes: 7,
      groupMatchCount: 80,
      sources: {
        groupCount: { ownership: 'automatic', sentence: '41 players ÷ about 5 per group' },
        groupSize: {
          ownership: 'manual',
          sentence: 'You set the target. We derived the group count.',
        },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 9 groups.',
        },
      },
      disagreement: null,
      unevenDistribution: [
        { groups: 8, size: 5 },
        { groups: 1, size: 1 },
      ],
      // The ninth group, so Group I — past the single-letter cases the earlier vectors pin.
      impossibleProblems: [
        {
          kind: 'group',
          title: 'Group I would have one player',
          body: 'They would have nobody to play. Use fewer groups or raise the player limit.',
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
    // renderer's job — and the group-size sentence is where the 16 shows up.
    name: 'no cap: the uncapped preview field of 16 players',
    input: {
      previewFieldSize: 16,
      reservationCount: 4,
      groupCountMode: 'automatic',
      manualGroupCount: null,
      groupSizeMode: 'automatic',
      manualGroupSize: null,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      groupCount: 4,
      groupSizes: [4, 4, 4, 4],
      qualifiersPerGroup: 2,
      totalQualifiers: 8,
      knockoutBracketSize: 8,
      firstRoundByes: 0,
      groupMatchCount: 24,
      sources: {
        groupCount: {
          ownership: 'automatic',
          sentence: "4 reservations · today's behaviour",
        },
        groupSize: { ownership: 'automatic', sentence: '16 players ÷ 4 groups' },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 4 groups.',
        },
      },
      disagreement: null,
      unevenDistribution: null,
      impossibleProblems: [],
    },
  },

  {
    // An event with no group rows yet. The count clamps to one, and the sentence reports
    // the number the derivation USED — `1 reservations`, unpluralised, because the
    // sentence explains the division that happened and the reference does not pluralise.
    name: 'no reservations yet: the count clamps to one and the sentence says so',
    input: {
      previewFieldSize: 16,
      reservationCount: 0,
      groupCountMode: 'automatic',
      manualGroupCount: null,
      groupSizeMode: 'automatic',
      manualGroupSize: null,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      groupCount: 1,
      groupSizes: [16],
      qualifiersPerGroup: 8,
      totalQualifiers: 8,
      knockoutBracketSize: 8,
      firstRoundByes: 0,
      groupMatchCount: 120,
      sources: {
        groupCount: {
          ownership: 'automatic',
          sentence: "1 reservations · today's behaviour",
        },
        groupSize: { ownership: 'automatic', sentence: '16 players ÷ 1 groups' },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 1 groups.',
        },
      },
      disagreement: null,
      unevenDistribution: null,
      impossibleProblems: [],
    },
  },

  {
    // A director typing a zero into the group-size box. It clamps to one, and — the same
    // rule as the reservation sentence above — the copy reports the clamped value, not
    // the zero, because that is the division that was actually done.
    name: 'a manual group size of zero clamps to one, in the maths and in the copy',
    input: {
      previewFieldSize: 3,
      reservationCount: 4,
      groupCountMode: 'automatic',
      manualGroupCount: null,
      groupSizeMode: 'manual',
      manualGroupSize: 0,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      groupCount: 3,
      groupSizes: [1, 1, 1],
      qualifiersPerGroup: 3,
      totalQualifiers: 9,
      knockoutBracketSize: 9,
      firstRoundByes: 7,
      groupMatchCount: 0,
      sources: {
        groupCount: { ownership: 'automatic', sentence: '3 players ÷ about 1 per group' },
        groupSize: {
          ownership: 'manual',
          sentence: 'You set the target. We derived the group count.',
        },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 3 groups.',
        },
      },
      disagreement: null,
      unevenDistribution: null,
      impossibleProblems: [
        {
          kind: 'group',
          title: 'Group A would have one player',
          body: 'They would have nobody to play. Use fewer groups or raise the player limit.',
        },
      ],
    },
  },

  {
    // A field of nobody — the state a brand-new event with a zero cap would preview. The
    // group refusal has a second sentence for it: `no players`, not `one player`.
    name: 'an empty field: the groups have no players at all',
    input: {
      previewFieldSize: 0,
      reservationCount: 3,
      groupCountMode: 'automatic',
      manualGroupCount: null,
      groupSizeMode: 'automatic',
      manualGroupSize: null,
      qualifiersMode: 'automatic',
      manualQualifiers: null,
    },
    expected: {
      groupCount: 3,
      groupSizes: [0, 0, 0],
      qualifiersPerGroup: 3,
      totalQualifiers: 9,
      knockoutBracketSize: 9,
      firstRoundByes: 7,
      groupMatchCount: 0,
      sources: {
        groupCount: {
          ownership: 'automatic',
          sentence: "3 reservations · today's behaviour",
        },
        groupSize: { ownership: 'automatic', sentence: '0 players ÷ 3 groups' },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 3 groups.',
        },
      },
      disagreement: null,
      unevenDistribution: null,
      impossibleProblems: [
        {
          kind: 'group',
          title: 'Group A would have no players',
          body: 'They would have nobody to play. Use fewer groups or raise the player limit.',
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
      reservationCount: 4,
      groupCountMode: 'manual',
      manualGroupCount: null,
      groupSizeMode: 'manual',
      manualGroupSize: null,
      qualifiersMode: 'manual',
      manualQualifiers: null,
    },
    expected: {
      groupCount: 4,
      groupSizes: [8, 8, 8, 8],
      qualifiersPerGroup: 2,
      totalQualifiers: 8,
      knockoutBracketSize: 8,
      firstRoundByes: 0,
      groupMatchCount: 112,
      sources: {
        groupCount: {
          ownership: 'automatic',
          sentence: "4 reservations · today's behaviour",
        },
        groupSize: { ownership: 'automatic', sentence: '32 players ÷ 4 groups' },
        qualifiers: {
          ownership: 'automatic',
          sentence: 'Aiming at an 8-player knockout across 4 groups.',
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

describe('groupLetter', () => {
  // The naming the group refusal and the preview cards both read off. Past Z it keeps
  // naming groups instead of printing punctuation — `String.fromCharCode(65 + 26)` is `[`.
  //
  // ⚠️ **This table is asserted on the other side too**: `api/tests/test_draws.py` pins
  // the identical seven `(position, label)` pairs, with a comment pointing back at this
  // file (ticket #1369). Positions 26 and 52 are the mandatory ones — the carry is
  // `n // 26 - 1`, and a naive `n // 26` agrees for 0–25 then silently diverges, so a
  // vector that stopped at `Z` would pass a broken carry.
  it('names groups A onwards, and keeps going past Z', () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(groupLetter)).toEqual([
      'A',
      'B',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
    ])
  })
})
