import { render, screen, type Container } from '@/test/utilities'

import { DrawIssuePanel, type DrawIssuePanelProps } from './draw-issue-panel'
import { buildDrawIssuePanelProps } from './draw-issue-panel.factory'

const scoped = (container: Container) => ({
  /** The panel. */
  getPanel() {
    return container.getByTestId('draw-issue-panel')
  },
  /** The panel, or `null` — **the accessor the precedence claims use**. Only one notice
   * shows at a time, and the two unbuilt kinds (chores 4c and 5a) show none at all, so
   * "there is no panel" is a state a test has to be able to state. */
  queryPanel() {
    return container.queryByTestId('draw-issue-panel')
  },
  /** The topline — `Legal, but uneven`. Read as TEXT: the dot beside it is decoration,
   * and a notice whose meaning is a colour has no meaning to a screen reader. */
  getTopline() {
    return container.getByText('Legal, but uneven')
  },
  /** The size tally — `2 groups of 6 · 2 groups of 5`. */
  getTitle() {
    return container.getByTestId('draw-issue-panel-title')
  },
  /** The line under it, saying what uneven costs and what was not done to it. */
  getBody() {
    return container.getByTestId('draw-issue-panel-body')
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
