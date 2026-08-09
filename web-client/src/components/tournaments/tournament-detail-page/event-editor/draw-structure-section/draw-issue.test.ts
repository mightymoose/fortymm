import {
  deriveDrawStructure,
  type DrawStructureOptions,
} from '../../../data/draw-structure'
import { drawIssueFor } from './draw-issue'

/** The eight derivation inputs, all-automatic, so a case states only what it changes.
 * Structures are **derived, never hand-written**: a `DrawStructure` typed out by hand can
 * hold a tally the arithmetic never produces, and then the precedence is proved against a
 * state no director can reach. */
const structureFor = (overrides: Partial<DrawStructureOptions>) =>
  deriveDrawStructure({
    previewFieldSize: 32,
    poolReservationCount: 4,
    poolCountMode: 'automatic',
    manualPoolCount: null,
    poolSizeMode: 'automatic',
    manualPoolSize: null,
    qualifiersMode: 'automatic',
    manualQualifiers: null,
    ...overrides,
  })

/**
 * The precedence the derivation deliberately does not encode. It reports the three
 * conditions independently and more than one can hold at once, so **this is the only
 * place that decides which one a director reads** — chores 4c and 5a extend the panel's
 * renderer and leave this alone.
 */
describe('drawIssueFor', () => {
  it('has nothing to say about a draw that divides — 32 across 4', () => {
    expect(drawIssueFor(structureFor({}))).toBeNull()
  })

  it('reports the uneven tally when that is all that is wrong — 22 across 4', () => {
    expect(drawIssueFor(structureFor({ previewFieldSize: 22 }))).toEqual({
      kind: 'uneven',
      distribution: [
        { pools: 2, size: 6 },
        { pools: 2, size: 5 },
      ],
    })
  })

  /**
   * ⚠️ The case the ordering exists for. 8 across 6 reservations splits `2, 2, 1, 1, 1,
   * 1`, so the derivation reports an uneven tally AND a pool nobody can play in — both
   * non-empty, at once. "Legal, but uneven" is not the thing to say about a pool of one.
   */
  it('puts an unplayable pool ahead of the uneven tally it comes with', () => {
    const structure = structureFor({
      previewFieldSize: 8,
      poolReservationCount: 6,
    })
    // Both really are set — otherwise this asserts precedence against a state that never
    // had two answers to choose between.
    expect(structure.unevenDistribution).not.toBeNull()
    expect(structure.impossibleProblems).toHaveLength(1)

    expect(drawIssueFor(structure)).toEqual({
      kind: 'impossible',
      problem: structure.impossibleProblems[0],
    })
  })

  /**
   * The reference's "Numbers disagree" state: 6 manual pools of 5 manual against a field
   * of 40. No input can put a disagreement and an uneven tally on screen together — both
   * modes manual gives every pool the same size — so this pins the middle rung of the
   * order rather than a contest, and it is what chore 5a extends.
   */
  it('reports the disagreement when the director’s two numbers do not multiply out', () => {
    const structure = structureFor({
      previewFieldSize: 40,
      poolCountMode: 'manual',
      manualPoolCount: 6,
      poolSizeMode: 'manual',
      manualPoolSize: 5,
    })

    expect(drawIssueFor(structure)).toEqual({
      kind: 'disagreement',
      disagreement: structure.disagreement,
    })
  })
})
