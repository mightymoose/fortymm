import { renderWithRoutes } from '@/test/router'
import { screen, within, type Container } from '@/test/utilities'

import {
  RatingChartDisplay,
  type RatingChartDisplayProps,
} from './rating-chart-display'
import { buildRatingChartDisplayProps } from './rating-chart-display.factory'

/** The route the range tabs link to — the profile itself, with a different window
 * selected. Registered as a stub in the harness so the typed `<Link>`s resolve. */
export const PROFILE_ROUTE = '/players/$userId'

const scoped = (container: Container) => ({
  /** The card, by its heading. Absent for an unrated player — they get the
   * "Unrated" panel instead, which carries the same heading but no chart. */
  getChartCard() {
    return container.getByRole('region', { name: 'Rating over time' })
  },
  findChartCard() {
    return container.findByRole('region', { name: 'Rating over time' })
  },
  queryChartCard() {
    return container.queryByRole('region', { name: 'Rating over time' })
  },
  /** The drawn line — an `<img>` whose accessible name IS the chart's sentence,
   * because that sentence is the whole of what the picture says. `null` whenever
   * there is no line: the in-card error state, or a cold pending one. */
  queryChartLine(): HTMLElement | null {
    return within(this.getChartCard()).queryByRole('img')
  },
  /** The card's sentence: "Up +127 over the last 90 days", "No rated matches in
   * the last 90 days", or — while another window loads — the range it is waiting
   * for. */
  getChartSummary(): string {
    return (
      this.getChartCard().querySelector('.rating-chart__summary')
        ?.textContent ?? ''
    )
  },
  /**
   * The signed change chip — **or `null`**, which is a first-class answer here:
   * an empty window has no change to report and must never render "+0"
   * (ADR-0915).
   */
  queryChangeChip(): HTMLElement | null {
    return this.getChartCard().querySelector('.rating-chart__chip')
  },
  /** The in-card failure — "Couldn't load that range", *in place of the SVG*, with
   * the rest of the profile still painted around it. */
  queryChartError(): HTMLElement | null {
    return within(this.getChartCard()).queryByRole('alert')
  },
  findChartError() {
    return within(this.getChartCard()).findByRole('alert')
  },
  /** The retry inside the card. */
  getRetry() {
    return within(this.getChartCard()).getByRole('button', {
      name: 'Try again',
    })
  },
  /** The placeholder shown when there is no line at all yet — neither a seeded one
   * nor a previous one. */
  queryChartPending(): HTMLElement | null {
    return container.queryByRole('status', { name: 'Loading chart data' })
  },
  /** One range tab, by its label ("30d" / "90d" / "1y"). A **link**, not a
   * button: the selected window is the URL. */
  getRangeTab(label: string) {
    return within(this.getChartCard()).getByRole('link', { name: label })
  },
  /** The window the card says it is showing. Throws unless exactly one tab is
   * current — the router marks its own active links, and without
   * `activeOptions={{ exact: true }}` the default tab (whose search is `{}`)
   * matches every URL and two tabs light up at once. */
  getSelectedRangeTab(): HTMLElement {
    const tabs = within(this.getChartCard())
      .getAllByRole('link')
      .filter((tab) => tab.getAttribute('aria-current') === 'page')
    if (tabs.length !== 1) {
      throw new Error(`Expected exactly one selected range tab, got ${tabs.length}`)
    }
    return tabs[0]
  },
  /** The `href` a tab navigates to. The default window's is deliberately clean —
   * no `?range=` at all. */
  getRangeTabHref(label: string): string {
    return this.getRangeTab(label).getAttribute('href') ?? ''
  },
  /** True while the card is holding the *previous* window's line on screen. */
  isChartBusy(): boolean {
    return (
      this.getChartCard()
        .querySelector('.rating-chart__canvas')
        ?.getAttribute('aria-busy') === 'true'
    )
  },
})

/**
 * Test page-object for `RatingChartDisplay` — the pure view-in, DOM-out card.
 *
 * Mounted under the router harness because the range tabs are typed `<Link>`s: the
 * selected window *is* the URL (ADR-0915), so a tab that were a plain button could
 * neither survive a reload nor be shared. That means every test against it starts
 * with an `await find…()` — the router resolves asynchronously.
 *
 * Every accessor is chart-scoped so the composed profile page object can spread it
 * alongside the hero's, the Career card's and the rest without a collision.
 */
export const ratingChartDisplayPage = {
  render(overrides: Partial<RatingChartDisplayProps> = {}) {
    renderWithRoutes(
      <RatingChartDisplay {...buildRatingChartDisplayProps(overrides)} />,
      { linkTargets: [PROFILE_ROUTE] },
    )
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
