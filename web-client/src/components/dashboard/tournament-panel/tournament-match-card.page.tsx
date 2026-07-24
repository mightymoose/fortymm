import { renderWithRoutes } from '@/test/router'
import { screen, within, type Container } from '@/test/utilities'

import {
  TournamentMatchCard,
  type TournamentMatchCardProps,
} from './tournament-match-card'
import { buildTournamentMatchCardProps } from './tournament-match-card.factory'
import { tournamentGameChipsPage } from './tournament-match-card/tournament-game-chips.page'

/** Every route a card can link to — the scoring page and match detail. */
const LINK_TARGETS = [
  '/matches/$matchId',
  '/matches/$matchId/games/$gameNumber/scores/new',
]

const scoped = (container: Container) => ({
  /** The card itself. */
  getCard() {
    return container.getByTestId('tournament-panel-match-card')
  },
  /** The card, or null — for asserting the parent rendered none. */
  queryCard() {
    return container.queryByTestId('tournament-panel-match-card')
  },
  /** The primary action link ("Enter Game 4 result"), or null when there is
   * nothing to enter. */
  queryActionLink(name: string | RegExp) {
    return container.queryByRole('link', { name })
  },
  /** The "Match details" link, or null for a fixture with no match behind it. */
  queryDetailsLink() {
    return container.queryByRole('link', { name: /match details/i })
  },
  /** The row of the scoreboard belonging to this player — scoped so the two
   * rows' scores and winner chips never cross-read. */
  getScoreRow(name: string) {
    const row = within(
      container.getByTestId('tournament-panel-match-card'),
    ).getByText(name).parentElement
    if (!(row instanceof HTMLElement)) {
      throw new Error(`No score row found for "${name}".`)
    }
    return row
  },
  // The chips' own content is pinned by their quartet; reuse their queries.
  chips: tournamentGameChipsPage.within(container),
})

/**
 * Test page-object for `TournamentMatchCard`.
 *
 * The card renders typed `<Link>`s, so `render` mounts it under the shared
 * memory-router harness with the scoring and match-detail routes registered.
 * The router resolves asynchronously — tests start with
 * `await tournamentMatchCardPage.findCard()`.
 */
export const tournamentMatchCardPage = {
  render(overrides: Partial<TournamentMatchCardProps> = {}) {
    renderWithRoutes(
      <TournamentMatchCard {...buildTournamentMatchCardProps(overrides)} />,
      { linkTargets: LINK_TARGETS },
    )
  },

  /** Async-first accessor — the router resolves the tree on first paint. */
  findCard() {
    return screen.findByTestId('tournament-panel-match-card')
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
