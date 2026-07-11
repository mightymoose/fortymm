import { renderWithRoutes } from '@/test/router'
import { screen, type Container } from '@/test/utilities'

import {
  RecentMatchesDisplay,
  type RecentMatchesDisplayProps,
} from './recent-matches-display'
import { buildRecentMatchesDisplayProps } from './recent-matches-display.factory'
import { recentMatchRowPage } from './recent-matches-display/recent-match-row.page'

/** The route the "View all N matches" footer link opens. Registered as a stub in
 * the harness so the typed `<Link>` resolves. */
export const MATCH_HISTORY_ROUTE = '/players/$userId/matches'

const scoped = (container: Container) => ({
  /** The card itself, named by its "Recent matches" heading. */
  getCard() {
    return container.getByRole('region', { name: 'Recent matches' })
  },
  findCard() {
    return container.findByRole('region', { name: 'Recent matches' })
  },
  /** Every match row on the card — the `<thead>` row is excluded. Six, when the
   * bundle carries six: a live or voided match is *not* filtered out. */
  getRows(): HTMLElement[] {
    return container
      .getAllByRole('row')
      .filter((row: HTMLElement) => row.querySelector('td') !== null)
  },
  /** The grid's column headers, in order. There is no "Result" among them: the
   * card has no result-chip column (ADR-0915). */
  getColumnHeaders(): string[] {
    return container
      .getAllByRole('columnheader')
      .map((header: HTMLElement) => header.textContent ?? '')
  },
  /** The footer link. Its accessible name carries the **all-inclusive** total
   * ("View all 50 matches"), not the decided count. `null` for a player with no
   * matches. */
  queryViewAllLink() {
    return container.queryByRole('link', { name: /view all/i })
  },
  getViewAllLink() {
    return container.getByRole('link', { name: /view all/i })
  },
  /** The empty state, for a player with no matches at all. */
  queryEmptyState() {
    return container.queryByText('No matches yet')
  },
  /** Per-row accessors (`getStatusDot`, `getScoreCell`, `getDeltaCell`,
   * `getWhenCell`), each taking the opponent's name — reuse them rather than
   * re-deriving the row's internals. */
  ...recentMatchRowPage.within(container),
})

/**
 * Test page-object for `RecentMatchesDisplay` — the pure view-in, DOM-out card.
 *
 * The footer renders a typed `<Link>`, so `render` mounts the card under a
 * memory router registering the match-history route. The router resolves
 * asynchronously: start tests with `await recentMatchesDisplayPage.findCard()`.
 */
export const recentMatchesDisplayPage = {
  render(overrides: Partial<RecentMatchesDisplayProps> = {}) {
    const props = buildRecentMatchesDisplayProps(overrides)
    renderWithRoutes(<RecentMatchesDisplay {...props} />, {
      linkTargets: [MATCH_HISTORY_ROUTE],
    })
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
