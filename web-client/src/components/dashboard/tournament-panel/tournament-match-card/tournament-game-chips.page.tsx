import { render, screen, within, type Container } from '@/test/utilities'

import {
  TournamentGameChips,
  type TournamentGameChipsProps,
} from './tournament-game-chips'
import { buildTournamentGameChipsProps } from './tournament-game-chips.factory'

const scoped = (container: Container) => ({
  /** The chips block, or null when there are no played games. */
  queryChips() {
    return container.queryByTestId('tournament-panel-game-chips')
  },
  /** Every chip, in play order. */
  getChips() {
    return within(
      container.getByTestId('tournament-panel-game-chips'),
    ).getAllByRole('listitem')
  },
})

/**
 * Test page-object for `TournamentGameChips`. Pure view-in — no router, no
 * network.
 */
export const tournamentGameChipsPage = {
  render(overrides: Partial<TournamentGameChipsProps> = {}) {
    render(<TournamentGameChips {...buildTournamentGameChipsProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
