import { Locator, Page } from '@playwright/test'

/** The rating chart's calendar windows — the labels its range tabs carry. */
export type RatingRange = '30d' | '90d' | '1y'

/** The profile's URL state: both params are *optional*, and their absence is
 * meaningful — no `?league=` means the default league, no `?range=` means the
 * default 90-day window. A spec passes a raw string (not a `RatingRange`) so it
 * can also drive a deliberately mangled one. */
export interface ProfileSearch {
  league?: string
  range?: string
}

/**
 * The player profile at `/players/$userId` — an overview of seven cards, all
 * painted from ONE bundle request, plus a rating chart that owns its own query
 * (ADR-0915).
 *
 * Scoped to what the composed-stack spec drives: the hero (proof the page is
 * painted), the **rating chart** with its range tabs, error state and retry, the
 * **Leagues** card (the page's league switcher), and the Career card — which is
 * cross-league and must NOT move when the league does.
 *
 * The chart's inner parts have no roles of their own beyond the SVG, so the two
 * CSS hooks below (`.rating-chart__summary`, `.rating-chart__canvas--loading`)
 * are kept here, inside the page object, and the spec reads intent-named
 * locators.
 */
export class PlayerProfilePage {
  private constructor(
    private readonly page: Page,
    readonly playerId: string,
  ) {}

  /** Open a player's profile, optionally with `?league=` / `?range=` already in
   * the URL (a deep link — the state the page must survive a reload into). */
  static async navigateTo(
    page: Page,
    playerId: string,
    search: ProfileSearch = {},
  ): Promise<PlayerProfilePage> {
    const params = new URLSearchParams()
    if (search.league !== undefined) params.set('league', search.league)
    if (search.range !== undefined) params.set('range', search.range)
    const query = params.toString()
    await page.goto(`/players/${playerId}${query ? `?${query}` : ''}`)
    return new PlayerProfilePage(page, playerId)
  }

  /** Adopt the profile the browser is *already* on (after a reload, or after a
   * range tab navigated). */
  static current(page: Page, playerId: string): PlayerProfilePage {
    return new PlayerProfilePage(page, playerId)
  }

  /* ------------------------------------------------------------------ hero -- */

  /** The player's username — the page's `<h1>`. The page is painted iff this is
   * visible. */
  get playerName(): Locator {
    return this.page.getByRole('heading', { level: 1 })
  }

  /* ----------------------------------------------------------- rating chart -- */

  /** The whole chart card. Every chart locator below is scoped to it, so a
   * "Try again" elsewhere on the page could never satisfy them. */
  get ratingChart(): Locator {
    return this.page.getByRole('region', { name: 'Rating over time' })
  }

  /**
   * The drawn line. An `<svg role="img">` whose accessible name is the window's
   * summary — "Up +12 over the last 90 days" — so asserting on this one locator
   * proves both that a chart is on screen *and* which window it is describing.
   *
   * Note the two shapes a summary can take: "…**over** the last 90 days" means
   * the window has rated matches in it; "No rated matches **in** the last 90
   * days" means it is empty. A spec that seeds a rated match should assert the
   * former, or it can pass with an empty chart.
   */
  get chartLine(): Locator {
    return this.ratingChart.getByRole('img')
  }

  /** The sentence under the heading. While a *different* range is loading it
   * reads "Loading the last 30 days…" — the one place the in-flight state of a
   * range flip is observable. */
  get chartSummary(): Locator {
    return this.ratingChart.locator('.rating-chart__summary')
  }

  /** The chart's *cold* placeholder — no line at all. It must **never** appear
   * during a range flip: the old line is held on screen (`keepPreviousData`)
   * while the new window loads. */
  get chartSkeleton(): Locator {
    return this.ratingChart.getByRole('status', { name: 'Loading chart data' })
  }

  /** The in-card failure: "Couldn't load that range", rendered where the SVG
   * goes, leaving the rest of the profile painted. */
  get chartError(): Locator {
    return this.ratingChart.getByRole('alert')
  }

  /** "Try again" — refetches the failed window from inside the card. */
  get chartRetry(): Locator {
    return this.ratingChart.getByRole('button', { name: 'Try again' })
  }

  /** A range tab (30d / 90d / 1y). They are real `<Link>`s: the selection *is*
   * the URL. */
  rangeTab(range: RatingRange): Locator {
    return this.ratingChart
      .getByRole('group', { name: 'Chart range' })
      .getByRole('link', { name: range, exact: true })
  }

  /* --------------------------------------------------------- leagues card -- */

  /** The Leagues card — the page's league switcher. */
  get leagues(): Locator {
    return this.page.getByRole('region', { name: 'Leagues' })
  }

  /** Every ladder this player is on. One row per league; each is a link to this
   * same profile with that league selected. */
  get leagueRows(): Locator {
    return this.leagues.getByRole('link')
  }

  /** The ladder the rating half of the page is currently bound to — marked
   * `aria-current="page"`. Exactly one row is current, always. */
  get selectedLeagueRow(): Locator {
    return this.leagues.locator('a[aria-current="page"]')
  }

  /* ---------------------------------------------------------- career card -- */

  /** The Career card. Cross-league by design: it must not move when the league
   * switcher does (ADR-0915). */
  get career(): Locator {
    return this.page.getByRole('region', { name: 'Career' })
  }

  /** Career's headline count — "1 decided · 1 league". The number the league
   * switch must leave alone. */
  get careerTotal(): Locator {
    return this.career.locator('.career-card__total')
  }
}
