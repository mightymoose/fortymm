// **The named ways out** (#1320): what the `Can’t save` and `Needs your call` panels offer,
// in the reference's words and with the reference's arithmetic.
//
// The derivation (`../../../data/draw-structure`) reports the three impossible
// competitions and the disagreement, and stops there, deliberately: a fix is a button, and
// a button is not a derivation. This module is the other half — the label, the detail line,
// and **the number the fix would write** — and it is data rather than a handler, so the
// panel can render a fix without knowing how to apply one and the tab can apply one without
// re-deriving its label.
//
// The copy and the maths are the README's "Impossible" and "Disagreement" sections
// (`docs/designs/rr-then-ko-draw-structure/README.md`), verbatim.
//
// ⚠️ **A fix is not a promise that the draw becomes legal.** `Use {floor(field / 2)} pools`
// against a manual pool size of one leaves every pool at one player, because both numbers
// are the director's and the app does not silently move the other one. That is the
// reference's arithmetic and it stays: the panel offers the named way out, the derivation
// re-runs, and if the draw is still impossible it says so again. The same holds for
// `Use {ceil(field / size)} pools of {size}` — see `disagreementFixes`.

import {
  tallyBalancedSplit,
  type DrawStructure,
  type DrawStructureDisagreement,
  type ImpossibleProblem,
} from '../../../data/draw-structure'

/**
 * One offered fix: what it says, and what it would set.
 *
 * A **discriminated union on what it writes**, not on which problem offered it, because the
 * tab routes it by the seam it touches — the pool rows, the player limit on Basics, the
 * qualifier count — and two problems can offer the same kind of write (`Take top 2` from a
 * one-player knockout and `Take top {min}` from too many qualifiers are one act with two
 * labels).
 */
export type DrawStructureFix =
  | {
      kind: 'pool-count'
      label: string
      detail: string
      /** How many pools — and therefore how many pool ROWS (ADR 20260808). */
      poolCount: number
    }
  | {
      kind: 'player-limit'
      label: string
      detail: string
      /** The event's cap, which lives on Basics. */
      maxPlayers: number
    }
  | {
      kind: 'qualifiers'
      label: string
      detail: string
      /** How many finishers come out of each pool. */
      qualifiersPerPool: number
    }
  | {
      /**
       * Hand the **pool size** back to the system, and nothing else: the director's pool
       * count stands, and the field splits across it.
       *
       * It carries no number, and that is the point — it is the one resolution that resolves
       * a disagreement by *un*-setting a number rather than by writing one. The other two
       * arms write; this one gives a setting back, through the same `Use automatic` the Pool
       * size row already offers.
       */
      kind: 'automatic-pool-size'
      label: string
      detail: string
    }

/**
 * The fixes for one impossible competition, in the order the reference lists them.
 *
 * - **A pool nobody can play in** offers two, because there are two honest ways out: fewer
 *   pools for the field there is, or a bigger field for the pools there are. Neither is
 *   picked for the director.
 * - **A one-player knockout** offers one: take two through instead of one. Two is always
 *   playable here — this problem is only reachable from a single pool taking a single
 *   qualifier, and that pool already survived the pool rule, so it holds at least two.
 * - **More qualifiers than the smallest pool holds** offers one: take what the pool has.
 *
 * `structure` and `fieldSize` are the numbers the derivation already produced, passed in
 * rather than recomputed — `floor(field / 2)` is a fix, but `min(sizes)` is a derived fact
 * and there is one place that decides it.
 */
export function impossibleFixes(
  problem: ImpossibleProblem,
  structure: DrawStructure,
  fieldSize: number,
): DrawStructureFix[] {
  switch (problem.kind) {
    case 'pool': {
      // Two players per pool is the smallest playable pool, so the most pools this field
      // can fill is half of it.
      const poolCount = Math.floor(fieldSize / 2)
      return [
        {
          kind: 'pool-count',
          label: `Use ${poolCount} pools`,
          detail: 'Every pool gets at least two players.',
          poolCount,
        },
        {
          kind: 'player-limit',
          // …and the other way round: the field the pools the director already booked
          // would need. `Keeps your pool count` is the whole point of offering both.
          label: `Raise the player limit to ${structure.poolCount * 2}`,
          detail: 'Keeps your pool count.',
          maxPlayers: structure.poolCount * 2,
        },
      ]
    }
    case 'bracket':
      return [
        {
          kind: 'qualifiers',
          label: 'Take top 2',
          detail: 'Creates a playable knockout.',
          qualifiersPerPool: 2,
        },
      ]
    case 'qualifier': {
      const smallestPool = Math.min(...structure.poolSizes)
      return [
        {
          kind: 'qualifiers',
          label: `Take top ${smallestPool}`,
          detail: 'Fits the smallest pool.',
          qualifiersPerPool: smallestPool,
        },
      ]
    }
  }
}

/**
 * The balanced split written out the way `Allow uneven pools` says it — `4 × 7 and 2 × 6`.
 *
 * ⚠️ **A multiplication sign** (`U+00D7`), not the letter `x`, and joined with ` and `
 * rather than the uneven notice's ` · `. The same two numbers are stated in two formats a
 * few pixels apart (`4 pools of 7 · 2 pools of 6` in the notice's title), and both are the
 * reference's. Do not unify them.
 *
 * A balanced split holds `base` and `base + 1` and nothing else, so this is one term or
 * two. There is no n-way join, because there is no split that would use one.
 */
function balancedSplitPhrase(fieldSize: number, poolCount: number): string {
  return tallyBalancedSplit(fieldSize, poolCount)
    .map((tally) => `${tally.pools} × ${tally.size}`)
    .join(' and ')
}

/**
 * The three resolutions for **numbers that disagree** — the reference's "Disagreement"
 * panel, in its order.
 *
 * The director set a pool count and a pool size whose product misses their field. Both
 * numbers were typed on purpose, so nothing here moves one of them on its own: each
 * resolution is a named act the director chooses, and the two they did not choose leave
 * their numbers exactly as they are.
 *
 * 1. **`Cap the field at {seats}`** moves the *field* to the structure — the player limit,
 *    which lives on Basics. `Your structure stays exact.` is literal: both of their numbers
 *    survive untouched.
 * 2. **`Use {ceil(field / size)} pools of {size}`** keeps the size and takes as many pools
 *    as the field needs — and therefore that many pool ROWS (ADR 20260808).
 * 3. **`Allow uneven pools`** keeps the count and hands the *size* back to the system, which
 *    splits the field across it. The detail states the split that would produce, so the
 *    director reads the answer before taking it.
 *
 * ⚠️ **`Use {ceil(field / size)} pools of {size}` does not always clear the disagreement**,
 * and the ceiling is why: 40 players in pools of 6 needs 7 pools, and 7 pools of 6 seat 42.
 * Everyone gets a seat — which is exactly what the detail line promises, and all it promises
 * — and two of them are empty, so the panel says so again with smaller numbers. That is the
 * reference's arithmetic, and correcting it to `floor` would seat 36 of the 40.
 *
 * Nothing is pluralised. `1 pools of 5` is reachable and is what the reference writes, for
 * the reason `Use 1 pools` is pinned above.
 */
export function disagreementFixes(
  disagreement: DrawStructureDisagreement,
): DrawStructureFix[] {
  const { poolCount, poolSize, seats, fieldSize } = disagreement
  const pooledCount = Math.max(1, Math.ceil(fieldSize / poolSize))
  return [
    {
      kind: 'player-limit',
      label: `Cap the field at ${seats}`,
      detail: 'Your structure stays exact.',
      maxPlayers: seats,
    },
    {
      kind: 'pool-count',
      label: `Use ${pooledCount} pools of ${poolSize}`,
      detail: 'Everyone gets a seat.',
      poolCount: pooledCount,
    },
    {
      kind: 'automatic-pool-size',
      label: 'Allow uneven pools',
      // The count the director keeps, split across the field they have.
      detail: `${balancedSplitPhrase(fieldSize, poolCount)} players.`,
    },
  ]
}
