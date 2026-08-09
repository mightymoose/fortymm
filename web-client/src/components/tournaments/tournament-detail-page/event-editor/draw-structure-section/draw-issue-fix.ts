// **The named ways out of a refusal** (#1320): what the `Can’t save` panel offers, in the
// reference's words and with the reference's arithmetic.
//
// The derivation (`../../../data/draw-structure`) reports the three impossible
// competitions and stops there, deliberately: a fix is a button, and a button is not a
// derivation. This module is the other half — the label, the detail line, and **the number
// the fix would write** — and it is data rather than a handler, so the panel can render a
// fix without knowing how to apply one and the tab can apply one without re-deriving its
// label.
//
// The copy and the maths are the README's "Impossible" section
// (`docs/designs/rr-then-ko-draw-structure/README.md`), verbatim.
//
// ⚠️ **A fix is not a promise that the draw becomes legal.** `Use {floor(field / 2)} pools`
// against a manual pool size of one leaves every pool at one player, because both numbers
// are the director's and the app does not silently move the other one. That is the
// reference's arithmetic and it stays: the panel offers the named way out, the derivation
// re-runs, and if the draw is still impossible it says so again.

import type { DrawStructure, ImpossibleProblem } from '../../../data/draw-structure'

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
