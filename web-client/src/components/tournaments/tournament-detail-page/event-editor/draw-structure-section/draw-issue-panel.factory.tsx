import type { DrawIssue } from './draw-issue'
import type { DrawStructureFix } from './draw-issue-fix'
import type { DrawIssuePanelProps } from './draw-issue-panel'

/**
 * The reference's **"Uneven field"** state
 * (`docs/designs/rr-then-ko-draw-structure/uneven-field-panel.png`): 22 players across 4
 * pools, which the balanced split makes `6, 6, 5, 5` and the tally reads out as
 * `2 pools of 6 · 2 pools of 5`.
 *
 * ⚠️ **Largest first**, because that is the order `tallySizes` produces and the order the
 * title states. A fixture written the other way round would pass a test that only counts
 * the entries and hide the one claim worth making.
 */
export function buildUnevenDrawIssue(
  overrides: Partial<Extract<DrawIssue, { kind: 'uneven' }>> = {},
): DrawIssue {
  return {
    kind: 'uneven',
    distribution: [
      { pools: 2, size: 6 },
      { pools: 2, size: 5 },
    ],
    ...overrides,
  }
}

/**
 * The reference's **"Field too small"** state
 * (`docs/designs/rr-then-ko-draw-structure/field-too-small-panel.png`): 8 players across 6
 * pools splits `2, 2, 1, 1, 1, 1`, and Pool C is the first pool with nobody to play.
 *
 * The words are the derivation's, copied from the vector `data/draw-structure.test.ts`
 * asserts, so a fixture cannot pin copy the derivation does not produce.
 */
export function buildImpossibleDrawIssue(
  overrides: Partial<Extract<DrawIssue, { kind: 'impossible' }>['problem']> = {},
): DrawIssue {
  return {
    kind: 'impossible',
    problem: {
      kind: 'pool',
      title: 'Pool C would have one player',
      body: 'They would have nobody to play. Use fewer pools or raise the player limit.',
      ...overrides,
    },
  }
}

/** The two fixes that same state offers — `impossibleFixes` computes them from a real
 * derivation (`./draw-issue-fix.test.ts` pins that), and this is what they come out as for
 * 8 players over 6 pools. */
export function buildImpossibleDrawFixes(): DrawStructureFix[] {
  return [
    {
      kind: 'pool-count',
      label: 'Use 4 pools',
      detail: 'Every pool gets at least two players.',
      poolCount: 4,
    },
    {
      kind: 'player-limit',
      label: 'Raise the player limit to 12',
      detail: 'Keeps your pool count.',
      maxPlayers: 12,
    },
  ]
}

/**
 * The reference's **"Numbers disagree"** state
 * (`docs/designs/rr-then-ko-draw-structure/numbers-disagree-panel.png`), and #1320's
 * required case: a field of 40 against six manual pools of five manual, which seat thirty
 * and leave ten entrants with nowhere to go.
 *
 * The numbers are the derivation's, and `data/draw-structure.test.ts` pins that it produces
 * exactly these for these inputs — a fixture cannot invent a standoff the derivation would
 * not report.
 */
export function buildDisagreementDrawIssue(
  overrides: Partial<Extract<DrawIssue, { kind: 'disagreement' }>['disagreement']> = {},
): DrawIssue {
  return {
    kind: 'disagreement',
    disagreement: {
      poolCount: 6,
      poolSize: 5,
      seats: 30,
      fieldSize: 40,
      direction: 'unseated',
      count: 10,
      ...overrides,
    },
  }
}

/** The three resolutions that same state offers — `disagreementFixes` computes them
 * (`./draw-issue-fix.test.ts` pins that), and this is what they come out as for 40 players
 * over 6 pools of 5. */
export function buildDisagreementDrawFixes(): DrawStructureFix[] {
  return [
    {
      kind: 'player-limit',
      label: 'Cap the field at 30',
      detail: 'Your structure stays exact.',
      maxPlayers: 30,
    },
    {
      kind: 'pool-count',
      label: 'Use 8 pools of 5',
      detail: 'Everyone gets a seat.',
      poolCount: 8,
    },
    {
      kind: 'automatic-pool-size',
      label: 'Allow uneven pools',
      detail: '4 × 7 and 2 × 6 players.',
    },
  ]
}

/**
 * Props for `DrawIssuePanel` — the uneven notice above, which is the variant with nothing
 * to apply.
 *
 * `fixes: []` is the default because it is what every kind but `impossible` carries, and
 * what a reader is offered for all three (ADR-0015). A test that wants the refusal's two
 * fixes says so, which is what makes "the panel offers a way out" a claim rather than an
 * inheritance.
 */
export function buildDrawIssuePanelProps(
  overrides: Partial<DrawIssuePanelProps> = {},
): DrawIssuePanelProps {
  return {
    issue: buildUnevenDrawIssue(),
    fixes: [],
    onApplyFix: () => {},
    ...overrides,
  }
}
