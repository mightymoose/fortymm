import { render, screen, within, type Container } from '@/test/utilities'

import {
  RecentResultsCard,
  type RecentResultsCardProps,
} from './recent-results-card'
import { buildRecentResultsCardProps } from './recent-results-card.factory'

const scoped = (container: Container) => ({
  /** The card header band (carries the legacy `dashboard-recent-results`
   * testid the dashboard integration test pins). */
  getHeader() {
    return container.getByTestId('dashboard-recent-results')
  },
  /** The "No completed matches yet." empty state (absent when rows exist). */
  queryEmptyState() {
    return container.queryByText(/no completed matches yet/i)
  },
  /** The win-loss + last-N summary line in the header. */
  getSummary() {
    return container.getByText(/· last/i)
  },
  /** Every data (`<tbody>`) row — the column-header row is excluded. */
  getRows() {
    return container
      .queryAllByRole('row')
      .filter((row: HTMLElement) => within(row).queryAllByRole('cell').length > 0)
  },
  /** The data row for the given opponent label (e.g. "silva.r"). */
  getRow(opponentLabel: string) {
    const row = container.getByText(opponentLabel).closest('tr')
    if (!row) throw new Error(`No recent-results row for "${opponentLabel}"`)
    return row
  },
})

/**
 * Test page-object for `RecentResultsCard`. It renders no links, so no router
 * harness is needed — tests can read the synchronous accessors immediately.
 */
export const recentResultsCardPage = {
  render(overrides: Partial<RecentResultsCardProps> = {}) {
    const props = buildRecentResultsCardProps(overrides)
    render(<RecentResultsCard {...props} />)
  },

  /** Scope the accessors to a subtree so a parent page object can reuse them. */
  within(node: HTMLElement) {
    return scoped(within(node))
  },

  ...scoped(screen),
}
