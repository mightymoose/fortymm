import { renderWithRoutes } from '@/test/router'
import { screen, type Container } from '@/test/utilities'

import { Bracket, type BracketProps } from './bracket'
import { buildBracketProps } from './bracket.factory'
import {
  fixtureLinePage,
  fixtureLineTexts,
} from './round-list/fixture-line.page'

const scoped = (container: Container) => ({
  /** One round's column, addressed by its round number — the list of that round's cards. */
  getColumn(round: number) {
    return container.getByTestId(`bracket-round-${round}`)
  },
  queryColumn(round: number) {
    return container.queryByTestId(`bracket-round-${round}`)
  },
  /** The columns' accessible names, **left-to-right in DOM order** — the assertion that the
   * bracket is laid out as ordered rounds (`Quarterfinals … Final`), not a flat list. */
  getColumnNames(): string[] {
    return container
      .queryAllByTestId(/^bracket-round-/)
      .map((list: HTMLElement) => list.getAttribute('aria-label') ?? '')
  },
  /** One column's fixture cards, as text (`player.1 vs player.4`), in the order they render
   * — the shape a bye/progression assertion reads (a missing card, a seed seated early). */
  getColumnLines(round: number): string[] {
    return fixtureLineTexts(container.getByTestId(`bracket-round-${round}`))
  },
  // Every fixture card in scope, plus each card's per-side text and — once materialized —
  // its match link / status, straight from the reused FixtureLine page object.
  ...fixtureLinePage.within(container),
})

/**
 * Test page-object for `Bracket`.
 *
 * A materialized card renders a typed `<Link>` to its match (reused `FixtureLine`), which
 * needs a `RouterProvider` registering `/matches/$matchId` — so `render` mounts the bracket
 * under `renderWithRoutes`. That router resolves asynchronously, so tests start with an
 * `await bracketPage.findColumn(round)` before reading the synchronous accessors.
 */
export const bracketPage = {
  render(overrides: Partial<BracketProps> = {}) {
    renderWithRoutes(<Bracket {...buildBracketProps(overrides)} />, {
      linkTargets: ['/matches/$matchId'],
    })
  },

  /** Async-first: the router resolves the route tree on the first paint, so tests await
   * this before the synchronous accessors. */
  findColumn(round: number) {
    return screen.findByTestId(`bracket-round-${round}`)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
