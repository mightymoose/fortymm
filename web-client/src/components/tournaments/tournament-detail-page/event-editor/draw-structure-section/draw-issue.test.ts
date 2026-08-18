import {
  deriveDrawStructure,
  type DrawStructureOptions,
} from '../../../data/draw-structure'
import { drawIssueFor } from './draw-issue'

/** The seven derivation inputs, all-automatic over a field that divides, so a case
 * states only what it changes. Structures are **derived, never hand-written**: a
 * `DrawStructure` typed out by hand can hold a tally the arithmetic never produces, and
 * then the precedence is proved against a state no director can reach. */
const structureFor = (overrides: Partial<DrawStructureOptions>) =>
  deriveDrawStructure({
    previewFieldSize: 20,
    groupCountMode: 'automatic',
    manualGroupCount: null,
    groupSizeMode: 'automatic',
    manualGroupSize: null,
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
  it('has nothing to say about a draw that divides — 20 across 4', () => {
    expect(drawIssueFor(structureFor({}))).toBeNull()
  })

  it('reports the uneven tally when that is all that is wrong — 22 across 5', () => {
    expect(drawIssueFor(structureFor({ previewFieldSize: 22 }))).toEqual({
      kind: 'uneven',
      distribution: [
        { groups: 2, size: 5 },
        { groups: 3, size: 4 },
      ],
    })
  })

  /**
   * ⚠️ The case the ordering exists for. 8 across 6 manual groups splits `2, 2, 1, 1, 1,
   * 1`, so the derivation reports an uneven tally AND a group nobody can play in — both
   * non-empty, at once. "Legal, but uneven" is not the thing to say about a group of one.
   */
  it('puts an unplayable group ahead of the uneven tally it comes with', () => {
    const structure = structureFor({
      previewFieldSize: 8,
      groupCountMode: 'manual',
      manualGroupCount: 6,
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
   * The reference's "Numbers disagree" state: 6 manual groups of 5 manual against a field
   * of 40. No input can put a disagreement and an uneven tally on screen together — both
   * modes manual gives every group the same size — so this pins the middle rung of the
   * order rather than a contest, and it is what chore 5a extends.
   */
  it('reports the disagreement when the director’s two numbers do not multiply out', () => {
    const structure = structureFor({
      previewFieldSize: 40,
      groupCountMode: 'manual',
      manualGroupCount: 6,
      groupSizeMode: 'manual',
      manualGroupSize: 5,
    })

    expect(drawIssueFor(structure)).toEqual({
      kind: 'disagreement',
      disagreement: structure.disagreement,
    })
  })
})
