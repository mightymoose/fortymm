import {
  mockPlayerSearchEndpoint,
  type PlayerSearchResolver,
} from '@/mocks/endpoints/players/player-search.endpoint'
import {
  mockRecentOpponentsEndpoint,
  type RecentOpponentsResolver,
} from '@/mocks/endpoints/players/recent-opponents.endpoint'
import { server } from '@/mocks/server'
import { render, screen, type Container } from '@/test/utilities'

import { OpponentPicker, type OpponentPickerProps } from './opponent-picker'

const scoped = (container: Container) => ({
  /** A recent-opponent chip, found by accessible name. */
  findChip(name: string | RegExp) {
    return container.findByRole('button', { name })
  },
  /** The "Search all players" affordance. */
  querySearchAll() {
    return container.queryByRole('button', { name: /search all players/i })
  },
  /**
   * The "Back to recent opponents" affordance — the visible exit from search
   * mode (#895). Only rendered for a caller that *has* a recent grid to go back
   * to, so this is `null` on the `defaultToSearch` entry.
   */
  queryBackToRecent() {
    return container.queryByRole('button', {
      name: /back to recent opponents/i,
    })
  },
  findBackToRecent() {
    return container.findByRole('button', { name: /back to recent opponents/i })
  },
  /** The search combobox, present only once the search view is open. */
  queryCombobox() {
    return container.queryByRole('combobox')
  },
  getCombobox() {
    return container.getByRole('combobox')
  },
  findOption(name: string | RegExp) {
    return container.findByRole('option', { name })
  },
  /** The boundary's error fallback. */
  findAlert() {
    return container.findByRole('alert')
  },
  /** The "Try again" retry button in the error fallback. */
  getRetry() {
    return container.getByRole('button', { name: /try again/i })
  },
})

/**
 * Test page-object for `OpponentPicker` — the stateful wrapper that switches
 * between the recent grid and the search typeahead inside the error boundary.
 * Stubs both player endpoints; the session query uses the default handler.
 */
export const opponentPickerPage = {
  /** Stub `GET /v1/players/recent`. */
  mockRecent(resolver: RecentOpponentsResolver) {
    mockRecentOpponentsEndpoint(server, resolver)
  },
  /** Stub `GET /v1/players/search`. */
  mockSearch(resolver: PlayerSearchResolver) {
    mockPlayerSearchEndpoint(server, resolver)
  },

  render(overrides: Partial<OpponentPickerProps> = {}) {
    const props: OpponentPickerProps = {
      onPick: () => {},
      ...overrides,
    }
    render(<OpponentPicker {...props} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
