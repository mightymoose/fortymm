import {
  deriveDrawStructure,
  type DrawStructureOptions,
} from '../../../data/draw-structure'
import { impossibleFixes } from './draw-issue-fix'

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
