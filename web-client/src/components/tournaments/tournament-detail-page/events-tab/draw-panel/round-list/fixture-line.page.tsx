import { renderWithRoutes } from '@/test/router'
import { interactiveElementsIn } from '@/test/read-only'
import { screen, within, type Container } from '@/test/utilities'

import { FixtureLine, type FixtureLineProps } from './fixture-line'
import { buildFixtureLineProps } from './fixture-line.factory'

/** Every fixture line, wherever it is: the id prefix is the only thing that identifies
 * one, since a line is inert text with no role of its own. */
const FIXTURE_LINE_TESTID = /^fixture-line-/

/** A line as the reader sees it — `player.1 vs player.4`. Normalised, because the line
 * is three elements and the DOM's whitespace between them is not the fact under test. */
const lineText = (el: HTMLElement) =>
  (el.textContent ?? '').replace(/\s+/g, ' ').trim()

/** The fixture lines inside one DOM node (a round's `<ul>`, a group's `<section>`), in
 * DOM order, as text. The **sequence** is half of what a draw means, so it is the shape
 * every draw assertion reads. */
export function fixtureLineTexts(scope: HTMLElement): string[] {
  return within(scope).queryAllByTestId(FIXTURE_LINE_TESTID).map(lineText)
}

const scoped = (container: Container) => ({
  /** The line itself, addressed by the fixture's id — a round holds several of them. */
  getLine(fixtureId: string) {
    return container.getByTestId(`fixture-line-${fixtureId}`)
  },
  queryLine(fixtureId: string) {
    return container.queryByTestId(`fixture-line-${fixtureId}`)
  },
  /** Every fixture line in scope, in DOM order. */
  getLines(): HTMLElement[] {
    return container.queryAllByTestId(FIXTURE_LINE_TESTID)
  },
  /** Those lines as text: `['player.1 vs player.4', …]`. */
  getLineTexts(): string[] {
    return container
      .queryAllByTestId(FIXTURE_LINE_TESTID)
      .map((el: HTMLElement) => lineText(el))
  },
  /** Everything interactive in a line. Empty for a *planned* pairing — there is nothing
   * to click on it until it materializes (#788) — and exactly the "View match" link once
   * it has. */
  getControls(fixtureId: string) {
    return interactiveElementsIn(container.getByTestId(`fixture-line-${fixtureId}`))
  },
  /** The "View match" link a materialized slot carries, scoped to its line. */
  getMatchLink(fixtureId: string) {
    return within(container.getByTestId(`fixture-line-${fixtureId}`)).getByRole(
      'link',
    )
  },
  queryMatchLink(fixtureId: string) {
    return within(container.getByTestId(`fixture-line-${fixtureId}`)).queryByRole(
      'link',
    )
  },
  /** The slot's match-status text (`In progress`, `Completed`, …). */
  getMatchStatus(fixtureId: string) {
    return within(container.getByTestId(`fixture-line-${fixtureId}`)).getByTestId(
      'fixture-match-status',
    )
  },
})

/**
 * Test page-object for `FixtureLine`.
 *
 * A materialized fixture line renders a typed `<Link>` to its match, which needs a
 * `RouterProvider` whose route tree registers `/matches/$matchId` — so `render` mounts
 * the line under `renderWithRoutes`. That router resolves asynchronously, so tests start
 * with `await fixtureLinePage.findLine(id)` before reading the synchronous accessors.
 *
 * The line is an `<li>`, valid only inside a list, so it renders wrapped in a `<ul>`: a
 * page object that dropped it into a bare `<div>` would be asserting against markup the
 * app never produces.
 */
export const fixtureLinePage = {
  render(overrides: Partial<FixtureLineProps> = {}) {
    renderWithRoutes(
      <ul>
        <FixtureLine {...buildFixtureLineProps(overrides)} />
      </ul>,
      { linkTargets: ['/matches/$matchId'] },
    )
  },

  /** Async-first: the router resolves the route tree on the first paint, so tests await
   * this before reading the synchronous accessors. */
  findLine(fixtureId: string) {
    return screen.findByTestId(`fixture-line-${fixtureId}`)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
