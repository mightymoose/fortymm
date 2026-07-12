import { renderWithRoutes } from '@/test/router'
import { screen, within, type Container } from '@/test/utilities'

import {
  LeaguesCardDisplay,
  type LeaguesCardDisplayProps,
} from './leagues-card-display'
import { buildLeaguesCardDisplayProps } from './leagues-card-display.factory'

/** The route every league row links to — the profile itself, with a different
 * league selected. Registered as a stub in the harness so the typed `<Link>`s
 * resolve. */
export const PROFILE_ROUTE = '/players/$userId'

const scoped = (container: Container) => ({
  /** The card itself, named by its "Leagues" heading. */
  getLeaguesCard() {
    return container.getByRole('region', { name: 'Leagues' })
  },
  findLeaguesCard() {
    return container.findByRole('region', { name: 'Leagues' })
  },
  /** Every league row. Each is a **link**, not a list item — the selection is the
   * URL, so the rows have to be navigable, shareable and reloadable. */
  getLeagueRows(): HTMLElement[] {
    return within(container.getByRole('region', { name: 'Leagues' })).getAllByRole(
      'link',
    )
  },
  /** One league's row, by name. */
  getLeagueRow(name: string): HTMLElement {
    const row = this.getLeagueRows().find((link) =>
      within(link).queryByText(name),
    )
    if (!row) throw new Error(`No league row named "${name}"`)
    return row
  },
  /**
   * The row the page's ratings are currently about. Exactly one, always —
   * `aria-current="page"`, so the active ladder is announced and not merely
   * tinted.
   *
   * It **throws** on anything but exactly one, which is the point: the router
   * stamps its own `aria-current="page"` on any link it considers active, and
   * with its default (partial) search comparison the default league's row matches
   * every URL — so a card without `activeOptions={{ exact: true }}` highlights
   * two ladders at once, and this accessor is what catches it.
   */
  getSelectedLeagueRow(): HTMLElement {
    const selected = this.getLeagueRows().filter(
      (link) => link.getAttribute('aria-current') === 'page',
    )
    if (selected.length !== 1) {
      throw new Error(
        `Expected exactly one selected league row, found ${selected.length}`,
      )
    }
    return selected[0]
  },
  /** The name of the selected league — the answer to "which ladder are the
   * hero's numbers about?". */
  getSelectedLeagueName(): string {
    return (
      this.getSelectedLeagueRow().querySelector('.leagues-card__name')
        ?.textContent ?? ''
    )
  },
  /** The rating a row prints — the player's rating **on that ladder**, or an em
   * dash when they hold none there. */
  getLeagueRating(name: string): string {
    return (
      this.getLeagueRow(name).querySelector('.leagues-card__rating')
        ?.textContent ?? ''
    )
  },
  /** The `href` a row navigates to. The default league's is deliberately clean —
   * no `?league=` at all. */
  getLeagueHref(name: string): string {
    return this.getLeagueRow(name).getAttribute('href') ?? ''
  },
  /** The "Default" badge, on the one league every player is joined to on sign-up.
   * `null` on every other row. */
  queryDefaultBadge(name: string): HTMLElement | null {
    return within(this.getLeagueRow(name)).queryByText('Default')
  },
})

/**
 * Test page-object for `LeaguesCardDisplay` — the pure view-in, DOM-out card.
 *
 * Mounted under the router harness, because the rows are typed `<Link>`s: the
 * league selection *is* the URL (ADR-0915), so a row that were a plain button
 * could not survive a reload or be shared. That also means every test against it
 * must start with an `await find…()` — the router resolves asynchronously.
 *
 * Every accessor is league-prefixed so the composed profile page object can
 * spread it alongside the hero's, the Career card's and the rest without a
 * collision.
 */
export const leaguesCardDisplayPage = {
  render(overrides: Partial<LeaguesCardDisplayProps> = {}) {
    renderWithRoutes(
      <LeaguesCardDisplay {...buildLeaguesCardDisplayProps(overrides)} />,
      { linkTargets: [PROFILE_ROUTE] },
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
