import { renderWithRoutes } from '@/test/router'
import { screen, type Container } from '@/test/utilities'

import { SwissRounds, type SwissRoundsProps } from './swiss-rounds'
import { buildSwissRoundsProps } from './swiss-rounds.factory'
import {
  fixtureLinePage,
  fixtureLineTexts,
} from './round-list/fixture-line.page'

const scoped = (container: Container) => ({
  /** One **paired** round's list of fixtures, by round number. `query…` because its absence
   * is exactly what a forthcoming round asserts. */
  getRound(round: number) {
    return container.getByTestId(`swiss-round-${round}`)
  },
  queryRound(round: number) {
    return container.queryByTestId(`swiss-round-${round}`)
  },

  /** One **forthcoming** round's line — the round that exists, is cut, and has nobody in it
   * yet. `query…` for the same reason, from the other side. */
  queryForthcoming(round: number) {
    return container.queryByTestId(`swiss-round-forthcoming-${round}`)
  },
  getForthcoming(round: number) {
    return container.getByTestId(`swiss-round-forthcoming-${round}`)
  },
  /** That line as one normalised string — the copy is the whole content of a forthcoming
   * round, so it is read as text rather than as a node. */
  getForthcomingText(round: number) {
    return (
      container.getByTestId(`swiss-round-forthcoming-${round}`).textContent ?? ''
    )
      .replace(/\s+/g, ' ')
      .trim()
  },

  /** One round's **bye** line — who sits it out. `query…` because its absence is the
   * assertion for an even field and for a round nobody is paired in yet. */
  queryBye(round: number) {
    return container.queryByTestId(`swiss-round-bye-${round}`)
  },
  /** That line as one normalised string (`Bye: player.7`) — read as text, because naming
   * the player IS the whole content of it. */
  getByeText(round: number) {
    return (container.getByTestId(`swiss-round-bye-${round}`).textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim()
  },

  /** Every round heading in DOM order (`['Round 1', 'Round 2', …]`) — the assertion that
   * **every** cut round is on screen, forthcoming ones included, in order. Read off the
   * headings rather than the lists, because a forthcoming round has no list. */
  getRoundHeadings(): string[] {
    return container
      .queryAllByText(/^Round \d+$/)
      .map((el: HTMLElement) => (el.textContent ?? '').trim())
  },

  /** One paired round's fixture lines, as text (`player.1 vs player.4`), in render order. */
  getRoundLines(round: number): string[] {
    return fixtureLineTexts(container.getByTestId(`swiss-round-${round}`))
  },

  // Every fixture line in scope, plus each line's per-side text and match link, straight
  // from the reused FixtureLine page object.
  ...fixtureLinePage.within(container),
})

/**
 * Test page-object for `SwissRounds`.
 *
 * A materialized fixture renders a typed `<Link>` to its match (reused `FixtureLine`),
 * which needs a `RouterProvider` registering `/matches/$matchId` — so `render` mounts under
 * `renderWithRoutes`. That router resolves asynchronously, so tests start with an
 * `await swissRoundsPage.findRound(n)` before reading the synchronous accessors.
 */
export const swissRoundsPage = {
  render(overrides: Partial<SwissRoundsProps> = {}) {
    renderWithRoutes(<SwissRounds {...buildSwissRoundsProps(overrides)} />, {
      linkTargets: ['/matches/$matchId'],
    })
  },

  /** Async-first: the router resolves the route tree on the first paint. */
  findRound(round: number) {
    return screen.findByTestId(`swiss-round-${round}`)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
