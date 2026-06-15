import type { Player } from '@/api/matches'
import {
  mockRecentOpponentsEndpoint,
  type RecentOpponentsResolver,
} from '@/mocks/endpoints/players/recent-opponents.endpoint'
import { server } from '@/mocks/server'
import { render, screen, type Container } from '@/test/utilities'

import { RecentOpponents, type RecentOpponentsProps } from './recent-opponents'

const scoped = (container: Container) => ({
  /** A recent-opponent chip, found by its accessible name. */
  findChip(name: string | RegExp) {
    return container.findByRole('button', { name })
  },
  queryChip(name: string | RegExp) {
    return container.queryByRole('button', { name })
  },
  /** The "Search all players" affordance, hidden until chips exist. */
  querySearchAll() {
    return container.queryByRole('button', { name: /search all players/i })
  },
  /** The loading skeleton's status node. */
  queryLoading() {
    return container.queryByRole('status', { name: /loading players/i })
  },
  /** The "no other players yet" empty state. */
  queryEmpty() {
    return container.queryByText(/no other players yet/i)
  },
  findEmpty() {
    return container.findByText(/no other players yet/i)
  },
})

/**
 * Test page-object for `RecentOpponents`. Stubs `GET /v1/players/recent` (the
 * session query uses the default handler), and exposes the chips, the search
 * affordance, and the loading / empty states.
 */
export const recentOpponentsPage = {
  /** Stub `GET /v1/players/recent`. */
  mockRecent(resolver: RecentOpponentsResolver) {
    mockRecentOpponentsEndpoint(server, resolver)
  },

  render(overrides: Partial<RecentOpponentsProps> = {}) {
    const props: RecentOpponentsProps = {
      onPick: () => {},
      onSearchAll: () => {},
      ...overrides,
    }
    render(<RecentOpponents {...props} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}

export type { Player }
