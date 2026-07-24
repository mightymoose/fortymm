import { renderWithRoutes } from '@/test/router'
import { screen, within, type Container } from '@/test/utilities'

import { TournamentPanel, type TournamentPanelProps } from './tournament-panel'
import { buildTournamentPanelProps } from './tournament-panel.factory'
import { tournamentMatchCardPage } from './tournament-panel/tournament-match-card.page'
import { tournamentPathListPage } from './tournament-panel/tournament-path-list.page'
import { tournamentStatsStripPage } from './tournament-panel/tournament-stats-strip.page'

/** Every route the panel and its children link to. */
const LINK_TARGETS = [
  '/tournaments/$tournamentId',
  '/matches/$matchId',
  '/matches/$matchId/games/$gameNumber/scores/new',
]

const scoped = (container: Container) => ({
  /** The panel section, or null when the dashboard rendered none. */
  queryPanel() {
    return container.queryByTestId('dashboard-tournament-panel')
  },
  /** The tournament's name — the panel's own heading. */
  getHeading(name: string | RegExp) {
    return container.getByRole('heading', { name })
  },
  /** The "N live now" pill, or null when nothing of the viewer's is live. */
  queryLiveBadge() {
    return container.queryByText(/live now$/)
  },
  /** The header link out to the tournament page. */
  getDestinationLink(name: string | RegExp) {
    return container.getByRole('link', { name })
  },
  /** Every event tab, in render order. */
  getTabs() {
    return within(
      container.getByTestId('dashboard-tournament-panel'),
    ).getAllByRole('tab')
  },
  /** One event tab by its name. */
  getTab(name: string | RegExp) {
    return container.getByRole('tab', { name })
  },
  /** The visible tab panel — Radix unmounts the inactive ones. */
  getActivePanel() {
    return within(
      container.getByTestId('dashboard-tournament-panel'),
    ).getByRole('tabpanel')
  },
  /** The "no draw yet" placeholder that stands in for the match card. */
  queryNoMatchNotice() {
    return container.queryByTestId('tournament-panel-no-match')
  },
  // Children's internals are pinned by their own quartets; reuse their queries
  // so this page object asserts wiring, not markup it does not own.
  matchCard: tournamentMatchCardPage.within(container),
  stats: tournamentStatsStripPage.within(container),
  path: tournamentPathListPage.within(container),
})

/**
 * Test page-object for `TournamentPanel`.
 *
 * The panel and its children render typed `<Link>`s, so `render` mounts it
 * under the shared memory-router harness. The router resolves asynchronously —
 * tests start with `await tournamentPanelPage.findHeading(...)`.
 */
export const tournamentPanelPage = {
  render(overrides: Partial<TournamentPanelProps> = {}) {
    renderWithRoutes(
      <TournamentPanel {...buildTournamentPanelProps(overrides)} />,
      { linkTargets: LINK_TARGETS },
    )
  },

  /** Async-first accessor — the router resolves the tree on first paint. */
  findHeading(name: string | RegExp) {
    return screen.findByRole('heading', { name })
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
