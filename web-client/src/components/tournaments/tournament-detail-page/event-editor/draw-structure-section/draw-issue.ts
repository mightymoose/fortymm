// **Which of the three notices the Draw structure tab shows.**
//
// `deriveDrawStructure` (`../../../data/draw-structure`) reports the three conditions
// independently and says out loud that it will not order them: more than one holds at
// once routinely, and picking between them is a layout question a derivation has no
// business answering. This module is the answer, and it is the ONLY place the answer
// exists — `DrawIssuePanel` renders whichever kind it is handed, and chores 4c and 5a add
// their variants to that renderer without touching this file.

import type {
  DrawStructure,
  DrawStructureDisagreement,
  ImpossibleProblem,
  PoolSizeTally,
} from '../../../data/draw-structure'

/**
 * The one thing the tab is telling the director about their numbers.
 *
 * A discriminated union rather than three nullable fields, because the tab shows exactly
 * one notice and a shape that can hold two would let a caller render both.
 */
export type DrawIssue =
  | { kind: 'impossible'; problem: ImpossibleProblem }
  | { kind: 'disagreement'; disagreement: DrawStructureDisagreement }
  | { kind: 'uneven'; distribution: PoolSizeTally[] }

/**
 * Pick the one issue, in the reference's order: impossible, then disagreement, then
 * uneven.
 *
 * The order is the order a director can act in. A draw that cannot be played is not
 * "your call", and an uneven split is not worth reading while a pool has one player in
 * it. A field of 8 across 6 pool reservations splits `2, 2, 1, 1, 1, 1` — an uneven tally
 * AND four unplayable pools, both reported — so this is a live case and not a defensive
 * one.
 */
export function drawIssueFor(structure: DrawStructure): DrawIssue | null {
  const [problem] = structure.impossibleProblems
  if (problem !== undefined) return { kind: 'impossible', problem }
  if (structure.disagreement !== null) {
    return { kind: 'disagreement', disagreement: structure.disagreement }
  }
  if (structure.unevenDistribution !== null) {
    return { kind: 'uneven', distribution: structure.unevenDistribution }
  }
  return null
}
