import { interactiveElementsIn } from '@/test/read-only'
import { render, screen, within, type Container } from '@/test/utilities'

import { FixtureLine, type FixtureLineProps } from './fixture-line'
import { buildFixtureLineProps } from './fixture-line.factory'

/** Every fixture line, wherever it is: the id prefix is the only thing that identifies
 * one, since a line is inert text with no role of its own. */
const FIXTURE_LINE_TESTID = /^fixture-line-/

/** A line as the reader sees it — `player.1 vs player.4`. Normalised, because the line
 * is three elements and the DOM's whitespace between them is not the fact under test. */
const lineText = (el: HTMLElement) =>
  (el.textContent ?? '').replace(/\s+/g, ' ').trim()

/** The fixture lines inside one DOM node (a round's `<ul>`, a pool's `<section>`), in
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
  /** Everything interactive in a line. Must always be empty: a fixture is a *planned*
   * pairing, not a match — there is nothing to click yet (#788). */
  getControls(fixtureId: string) {
    return interactiveElementsIn(container.getByTestId(`fixture-line-${fixtureId}`))
  },
})

/**
 * Test page-object for `FixtureLine`.
 *
 * `render` wraps the component in a `<ul>`: it renders an `<li>`, which is only valid
 * inside a list, and a page object that dropped it into a bare `<div>` would be
 * asserting against markup the app never produces.
 */
export const fixtureLinePage = {
  render(overrides: Partial<FixtureLineProps> = {}) {
    render(
      <ul>
        <FixtureLine {...buildFixtureLineProps(overrides)} />
      </ul>,
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
