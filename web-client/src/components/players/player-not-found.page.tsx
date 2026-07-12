import { renderWithRoutes } from '@/test/router'
import { notFoundContentPage } from '@/components/not-found-content.page'
import { screen, type Container } from '@/test/utilities'

import { PlayerNotFound } from './player-not-found'

/** The players-list route the one recovery action points at. */
export const PLAYERS_LIST_PATH = '/players'

const scoped = (container: Container) => ({
  // The body's own queries — headline, copy, meta, the recovery links, and the
  // `<main>` sweep — rather than re-deriving selectors this component doesn't
  // own. `NotFoundContent`'s page object is written to be spread like this.
  ...notFoundContentPage.within(container),

  /**
   * The display headline, awaited. `PlayerNotFound` renders a typed `<Link>`,
   * so it mounts under a memory router, and the router resolves
   * **asynchronously** — every test starts here.
   */
  findHeadline() {
    return container.findByRole('heading', { level: 1 })
  },

  /** The players-list stub route, rendered once the recovery link is followed. */
  findPlayersList() {
    return container.findByText(PLAYERS_LIST_PATH)
  },
})

/**
 * Test page-object for `PlayerNotFound`. The component takes no props (it is a
 * route `notFoundComponent`), so there's no factory — but it *does* contain a
 * typed `<Link to="/players">`, which needs a router whose tree registers that
 * target, hence `renderWithRoutes`.
 */
export const playerNotFoundPage = {
  render() {
    renderWithRoutes(<PlayerNotFound />, {
      linkTargets: [PLAYERS_LIST_PATH],
    })
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree, for a parent page object that embeds this state.
   */
  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
