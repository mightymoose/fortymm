import { render, screen, within, type Container } from '@/test/utilities'

import { DrawIssuePanel, type DrawIssuePanelProps } from './draw-issue-panel'
import { buildDrawIssuePanelProps } from './draw-issue-panel.factory'

/** One offered fix's own accessors, scoped to its row — the pool case offers two, and
 * they are otherwise identical markup. */
const scopedFix = (row: HTMLElement) => ({
  getRow() {
    return row
  },
  /** What the fix is called — `Use 4 pools`. */
  getLabel() {
    return within(row).getByTestId('draw-issue-fix-label')
  },
  /** The line under it, saying what the fix costs or keeps. */
  getDetail() {
    return within(row).getByTestId('draw-issue-fix-detail')
  },
  /** The button that applies it. */
  getApply() {
    return within(row).getByTestId('draw-issue-fix-apply')
  },
})

const scoped = (container: Container) => ({
  /** The panel. */
  getPanel() {
    return container.getByTestId('draw-issue-panel')
  },
  /** The panel, or `null` — **the accessor the precedence claims use**. Only one notice
   * shows at a time, and a draw whose numbers divide evenly gets none at all, so "there is
   * no panel" is a state a test has to be able to state. */
  queryPanel() {
    return container.queryByTestId('draw-issue-panel')
  },
  /** The topline — `Can’t save`, `Needs your call` or `Legal, but uneven`. Read as TEXT:
   * the dot beside it is decoration, and a notice whose meaning is a colour has no meaning
   * to a screen reader. */
  getTopline(words: string) {
    return container.getByText(words)
  },
  queryTopline(words: string) {
    return container.queryByText(words)
  },
  /** The size tally (`2 pools of 6 · 2 pools of 5`), the refusal's cause (`Pool C would
   * have one player`), or the standoff (`6 pools of 5 seat 30. Your field is 40.`). */
  getTitle() {
    return container.getByTestId('draw-issue-panel-title')
  },
  /** The line under it: what uneven costs, or what to do about the refusal. */
  getBody() {
    return container.getByTestId('draw-issue-panel-body')
  },
  /** Every offered fix, in the order the panel lists them. Empty for a notice with
   * nothing to fix, and for a reader (ADR-0015). */
  getFixes() {
    return container
      .queryAllByTestId('draw-issue-fix')
      .map((row: HTMLElement) => scopedFix(row))
  },
  /** Every fix's label, in order — the claim that the refusal offers *these two ways out,
   * in this order*, which no single-fix accessor can state. */
  getFixLabels(): string[] {
    return container
      .queryAllByTestId('draw-issue-fix-label')
      .map((node: HTMLElement) => (node.textContent ?? '').trim())
  },
  /** Apply one, the way a director does — by the button's accessible name, which names
   * the fix (`Apply Use 4 pools`) because every visible label reads only `Apply`. */
  getApplyButton(label: string) {
    return container.getByRole('button', { name: `Apply ${label}` })
  },
})

/** Test page-object for `DrawIssuePanel`, the Draw structure tab's one notice. */
export const drawIssuePanelPage = {
  render(overrides: Partial<DrawIssuePanelProps> = {}) {
    render(<DrawIssuePanel {...buildDrawIssuePanelProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
