import { render, screen, within, type Container } from '@/test/utilities'

import {
  RecentResultsCard,
  type RecentResultsCardProps,
} from './recent-results-card'
import { buildRecentResultsCardProps } from './recent-results-card.factory'

const scoped = (container: Container) => ({
  /** The results table, or null when the empty state is showing instead. */
  queryTable() {
    return container.queryByRole('table')
  },
  /** The "No completed matches yet." empty state, or null when rows exist. */
  queryEmptyState() {
    return container.queryByText('No completed matches yet.')
  },
  /** The win-loss tally + "last N" line in the header (e.g. "1-1 · last 2"). */
  getSummary(text: string | RegExp) {
    return container.getByText(text)
  },
  /** One result row, resolved by the opponent label shown in it. */
  getRow(opponentLabel: string) {
    const cell = container.getByText(opponentLabel)
    const row = cell.closest('tr')
    if (!row) throw new Error(`No results row for "${opponentLabel}"`)
    return within(row)
  },
  /** All opponent labels currently in the table. */
  queryOpponent(label: string) {
    return container.queryByText(label)
  },
})

/**
 * Test page-object for `RecentResultsCard` — the last-N completed matches
 * table. Accessors resolve a row by its opponent label, then read the score /
 * delta cells `within` that row. Owners (YourGameRow) spread `within`.
 */
export const recentResultsCardPage = {
  render(overrides: Partial<RecentResultsCardProps> = {}) {
    render(<RecentResultsCard {...buildRecentResultsCardProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
