import {
  deriveDrawStructure,
  type DrawStructureOptions,
} from '../../../data/draw-structure'
import { disagreementFixes, impossibleFixes } from './draw-issue-fix'

/** The eight inputs, stated in full at every vector — the derivation has no defaults
 * builder on purpose, and a fix computed off a hidden default would be a fix for a draw
 * nobody configured. */
const structureFor = (options: Partial<DrawStructureOptions>) =>
  deriveDrawStructure({
    previewFieldSize: 32,
    poolReservationCount: 4,
    poolCountMode: 'automatic',
    manualPoolCount: null,
    poolSizeMode: 'automatic',
    manualPoolSize: null,
    qualifiersMode: 'automatic',
    manualQualifiers: null,
    ...options,
  })

/** The fixes for a real derivation's first (and only) problem — asserted against the
 * derivation rather than a hand-built `ImpossibleProblem`, so a vector cannot offer a fix
 * for a competition the derivation would not have refused. */
const fixesFor = (options: Partial<DrawStructureOptions>, fieldSize: number) => {
  const structure = structureFor({ ...options, previewFieldSize: fieldSize })
  const [problem] = structure.impossibleProblems
  expect(problem).toBeDefined()
  return impossibleFixes(problem, structure, fieldSize)
}

describe('impossibleFixes', () => {
  /**
   * The reference's **"Field too small"** state
   * (`docs/designs/rr-then-ko-draw-structure/field-too-small-panel.png`): 8 players over 6
   * pools splits `2, 2, 1, 1, 1, 1`, and Pool C is the first pool with nobody to play.
   */
  describe('a pool nobody can play in — 8 players over 6 pools', () => {
    const fixes = () => fixesFor({ poolReservationCount: 6 }, 8)

    it('offers both ways out, and picks neither', () => {
      expect(fixes()).toHaveLength(2)
    })

    // Half the field, because two players is the smallest pool that can play a match.
    it('offers fewer pools — as many as the field can fill two apiece', () => {
      expect(fixes()[0]).toEqual({
        kind: 'pool-count',
        label: 'Use 4 pools',
        detail: 'Every pool gets at least two players.',
        poolCount: 4,
      })
    })

    // …and the other direction: the field the six pools the director booked would need.
    it('offers a bigger field, keeping the pools the director booked', () => {
      expect(fixes()[1]).toEqual({
        kind: 'player-limit',
        label: 'Raise the player limit to 12',
        detail: 'Keeps your pool count.',
        maxPlayers: 12,
      })
    })

    /**
     * ⚠️ **`Use 1 pools` is reachable, and it is what the reference says.** A field of two
     * or three halves to one, and the label does not pluralise: the README states this
     * string literally and says to treat it as exact, so the arithmetic is transcribed
     * rather than improved.
     *
     * It is pinned here so the wording is a **recorded decision** and not something a
     * director meets first. The tally next door (`1 pool of 4`) *is* pluralised, and that
     * deviation came with an argument of its own — it has no Python twin transcribing it
     * against shared vectors. This label may yet earn the same treatment; that is a call
     * for whoever owns the copy, not a tidy-up.
     */
    it('says `Use 1 pools`, unpluralised, when the field halves to one', () => {
      // 2 players over 2 reservations is one player per pool.
      expect(fixesFor({ poolReservationCount: 2 }, 2)).toEqual([
        {
          kind: 'pool-count',
          label: 'Use 1 pools',
          detail: 'Every pool gets at least two players.',
          poolCount: 1,
        },
        {
          kind: 'player-limit',
          label: 'Raise the player limit to 4',
          detail: 'Keeps your pool count.',
          maxPlayers: 4,
        },
      ])
    })
  })

  /**
   * #1320's own case: one pool taking one qualifier sends one player to the knockout, and
   * they would be handed the title without playing for it.
   */
  describe('a one-player knockout — 1 pool, top 1', () => {
    const fixes = () =>
      fixesFor(
        {
          poolReservationCount: 1,
          qualifiersMode: 'manual',
          manualQualifiers: 1,
        },
        16,
      )

    it('offers to take two through', () => {
      expect(fixes()).toEqual([
        {
          kind: 'qualifiers',
          label: 'Take top 2',
          detail: 'Creates a playable knockout.',
          qualifiersPerPool: 2,
        },
      ])
    })
  })

  /**
   * Three through from a pool that holds two. The fix is the pool's own size, so it names
   * a number the director can check against the preview rather than a constant.
   */
  describe('more qualifiers than the smallest pool holds — top 3 from a pool of 2', () => {
    const fixes = () =>
      fixesFor(
        {
          poolCountMode: 'manual',
          manualPoolCount: 4,
          qualifiersMode: 'manual',
          manualQualifiers: 3,
        },
        10,
      )

    // 10 across 4 is 3, 3, 2, 2 — so the smallest pool is two, not the average.
    it('offers to take what the SMALLEST pool holds', () => {
      expect(fixes()).toEqual([
        {
          kind: 'qualifiers',
          label: 'Take top 2',
          detail: 'Fits the smallest pool.',
          qualifiersPerPool: 2,
        },
      ])
    })
  })
})

/** The disagreement a real derivation reports for these inputs — asserted against the
 * derivation rather than a hand-built `DrawStructureDisagreement`, so a vector cannot offer
 * resolutions for a standoff the derivation would not have reported. A vector whose numbers
 * agree is a broken vector, not a case with no fixes. */
const disagreementFor = (options: Partial<DrawStructureOptions>, fieldSize: number) => {
  const { disagreement } = structureFor({ ...options, previewFieldSize: fieldSize })
  if (disagreement === null) {
    throw new Error('these inputs do not disagree — the vector is wrong, not the fix')
  }
  return disagreement
}

const resolutionsFor = (options: Partial<DrawStructureOptions>, fieldSize: number) =>
  disagreementFixes(disagreementFor(options, fieldSize))

describe('disagreementFixes', () => {
  /**
   * The reference's **"Numbers disagree"** state
   * (`docs/designs/rr-then-ko-draw-structure/numbers-disagree-panel.png`), and #1320's
   * required case: 40 players, six pools of five, which seat thirty.
   */
  describe('the field is bigger — 40 players, 6 pools of 5', () => {
    const both = { poolCountMode: 'manual', poolSizeMode: 'manual' } as const
    const fixes = () =>
      resolutionsFor({ ...both, manualPoolCount: 6, manualPoolSize: 5 }, 40)

    it('offers all three, and picks none', () => {
      expect(fixes()).toHaveLength(3)
    })

    /** Move the field to the structure: the cap becomes the seats the director's two
     * numbers already make, so **neither of their numbers moves**. */
    it('offers to cap the field at the seats they have', () => {
      expect(fixes()[0]).toEqual({
        kind: 'player-limit',
        label: 'Cap the field at 30',
        detail: 'Your structure stays exact.',
        maxPlayers: 30,
      })
    })

    /** …or move the structure to the field, keeping the pool size and taking as many pools
     * as it needs. `pool-count`, so the tab routes it to the pool ROWS (ADR 20260808). */
    it('offers as many pools of their size as the field needs', () => {
      expect(fixes()[1]).toEqual({
        kind: 'pool-count',
        label: 'Use 8 pools of 5',
        detail: 'Everyone gets a seat.',
        poolCount: 8,
      })
    })

    /**
     * …or keep the count and hand the size back. The detail states the split that would
     * produce, so the director reads the answer before taking it.
     *
     * ⚠️ A **multiplication sign** (`U+00D7`), not the letter `x`, joined with ` and `. The
     * uneven notice states the same two numbers as `4 pools of 7 · 2 pools of 6` — two
     * formats for one split, both the reference's, and neither is normalised into the
     * other.
     */
    it('offers the balanced split, tallied largest first', () => {
      expect(fixes()[2]).toEqual({
        kind: 'automatic-pool-size',
        label: 'Allow uneven pools',
        detail: '4 × 7 and 2 × 6 players.',
      })
    })
  })

  /**
   * The other direction: eight pools of six seat 48 and the field is 40, so eight seats go
   * empty rather than eight entrants going unseated.
   */
  describe('the field is smaller — 40 players, 8 pools of 6', () => {
    const fixes = () =>
      resolutionsFor(
        {
          poolCountMode: 'manual',
          manualPoolCount: 8,
          poolSizeMode: 'manual',
          manualPoolSize: 6,
        },
        40,
      )

    it('caps the field at the seats, downward as readily as upward', () => {
      expect(fixes()[0]).toEqual({
        kind: 'player-limit',
        label: 'Cap the field at 48',
        detail: 'Your structure stays exact.',
        maxPlayers: 48,
      })
    })

    /**
     * ⚠️ **`Everyone gets a seat.` is all this promises, and here it is all it delivers.**
     * 40 players in pools of six needs seven pools, and seven pools of six seat 42 — so the
     * panel comes back with the same question and smaller numbers. That is the reference's
     * `ceil`, and a `floor` "fix" would seat 36 of the 40.
     */
    it('rounds the pool count UP, and leaves a smaller disagreement behind', () => {
      expect(fixes()[1]).toEqual({
        kind: 'pool-count',
        label: 'Use 7 pools of 6',
        detail: 'Everyone gets a seat.',
        poolCount: 7,
      })

      const after = disagreementFor(
        {
          poolCountMode: 'manual',
          manualPoolCount: 7,
          poolSizeMode: 'manual',
          manualPoolSize: 6,
        },
        40,
      )
      expect(after.direction).toBe('empty-seats')
      expect(after.count).toBe(2)
    })

    /** One term, not two: 40 across 8 is five apiece, so the balanced split has one size in
     * it and there is nothing to join. */
    it('says one term when the split comes out even', () => {
      expect(fixes()[2]).toEqual({
        kind: 'automatic-pool-size',
        label: 'Allow uneven pools',
        detail: '8 × 5 players.',
      })
    })
  })

  /**
   * ⚠️ **`Use 1 pools of 5` is reachable, and it is unpluralised.** Four players in pools of
   * five need one pool, and the reference does not pluralise this label any more than it
   * pluralises `Use 1 pools` above — where the argument for transcribing rather than
   * improving is written out in full.
   */
  it('says `Use 1 pools of 5`, unpluralised, when one pool holds the field', () => {
    expect(
      resolutionsFor(
        {
          poolCountMode: 'manual',
          manualPoolCount: 2,
          poolSizeMode: 'manual',
          manualPoolSize: 5,
        },
        4,
      ),
    ).toEqual([
      {
        kind: 'player-limit',
        label: 'Cap the field at 10',
        detail: 'Your structure stays exact.',
        maxPlayers: 10,
      },
      {
        kind: 'pool-count',
        label: 'Use 1 pools of 5',
        detail: 'Everyone gets a seat.',
        poolCount: 1,
      },
      {
        kind: 'automatic-pool-size',
        label: 'Allow uneven pools',
        detail: '2 × 2 players.',
      },
    ])
  })
})
