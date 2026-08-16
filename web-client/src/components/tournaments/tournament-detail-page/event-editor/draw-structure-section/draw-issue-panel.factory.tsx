import type { DrawIssue } from './draw-issue'
import type { DrawIssuePanelProps } from './draw-issue-panel'

/**
 * The reference's **"Uneven field"** state
 * (`docs/designs/rr-then-ko-draw-structure/uneven-field-panel.png`): 22 players across 4
 * groups, which the balanced split makes `6, 6, 5, 5` and the tally reads out as
 * `2 groups of 6 · 2 groups of 5`.
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
      { groups: 2, size: 6 },
      { groups: 2, size: 5 },
    ],
    ...overrides,
  }
}

/** Props for `DrawIssuePanel` — the uneven notice above, which is the only variant this
 * chore renders. The impossible and disagreement kinds are built inline by the tests that
 * assert the panel stays silent for them (chores 4c and 5a). */
export function buildDrawIssuePanelProps(
  overrides: Partial<DrawIssuePanelProps> = {},
): DrawIssuePanelProps {
  return {
    issue: buildUnevenDrawIssue(),
    ...overrides,
  }
}
