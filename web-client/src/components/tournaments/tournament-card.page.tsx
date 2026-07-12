import { render, screen, type Container } from '@/test/utilities'

import { TournamentCard, type TournamentCardProps } from './tournament-card'
import { buildTournamentCardProps } from './tournament-card.factory'
import { statusBadgePage } from './status-badge.page'

const scoped = (container: Container) => ({
  /** The full-card open target, named for the tournament. */
  getOpenButton(name: string) {
    return container.getByRole('button', { name })
  },
  /** The hover delete control, named `Delete <tournament>`. */
  getDeleteButton(name: string) {
    return container.getByRole('button', { name: `Delete ${name}` })
  },
  /** The delete control, or null when absent (a non-creator's card). */
  queryDeleteButton(name: string) {
    return container.queryByRole('button', { name: `Delete ${name}` })
  },
  /** The venue line (pin icon + address). The whole row — icon included — is
   * absent when the tournament has no venue, city, or region, so this is a
   * `query`: its absence is the assertion (#994). */
  queryVenueLine() {
    return container.queryByTestId('tournament-venue-line')
  },
  /** The card's status pill, reusing the badge's own query. */
  ...statusBadgePage.within(container),
})

/**
 * Test page-object for `TournamentCard`. The card exposes two buttons — the
 * stretched open target (named for the tournament) and the delete control.
 */
export const tournamentCardPage = {
  render(overrides: Partial<TournamentCardProps> = {}) {
    render(<TournamentCard {...buildTournamentCardProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
