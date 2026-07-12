import type { Page } from '@playwright/test'

/**
 * A log of the two requests the player profile is allowed to make, as the
 * **browser** actually issues them.
 *
 * This is the whole reason the profile needs a composed-stack spec at all. The
 * page's contract is a contract about the *network* (ADR-0915):
 *
 * - the profile bundle is ONE request, and it embeds the rating window the chart
 *   paints first — so a first paint fires **no** rating-history request;
 * - flipping a range tab fires **exactly one** narrow rating-history request, and
 *   **no** second bundle request (the six bundle-backed cards must not refetch).
 *
 * Neither claim is checkable by reading the DOM, and a component test can only
 * assert them against a mock. Here we count what left the browser.
 *
 * Not a page object — it observes the page's network rather than driving its DOM
 * — so it lives in `support/` with the other test infra.
 */
export class ProfileRequests {
  private readonly bundleUrls: string[] = []
  private readonly historyUrls: string[] = []

  /**
   * Start listening. Attach *after* any API seeding and *before* the first
   * navigation: seeds go through `page.request` (an APIRequestContext), which
   * does not emit page network events, but attaching late removes all doubt.
   */
  constructor(page: Page, playerId: string) {
    const bundlePath = `/api/v1/players/${playerId}`
    const historyPath = `${bundlePath}/rating-history`
    page.on('request', (request) => {
      if (request.method() !== 'GET') return
      const url = new URL(request.url())
      // Exact pathname match, not `includes`: the bundle's path is a *prefix* of
      // the rating-history path (and of the full-history route's), so a substring
      // test would count one request as both.
      if (url.pathname === bundlePath) this.bundleUrls.push(url.href)
      else if (url.pathname === historyPath) this.historyUrls.push(url.href)
    })
  }

  /** Every profile-bundle request so far, as full URLs (query string included —
   * `league_id` / `range` are the interesting part). */
  get bundle(): readonly string[] {
    return this.bundleUrls
  }

  /** Every rating-history request so far, as full URLs. */
  get history(): readonly string[] {
    return this.historyUrls
  }

  /** Forget everything counted so far, so the next interaction is measured on
   * its own. The listener stays attached. */
  reset(): void {
    this.bundleUrls.length = 0
    this.historyUrls.length = 0
  }

  /** The `range` each rating-history request asked for, in order. `null` for a
   * request that named none (which means the default window). */
  historyRanges(): (string | null)[] {
    return this.historyUrls.map((href) =>
      new URL(href).searchParams.get('range'),
    )
  }

  /** The `league_id` each bundle request carried, in order. `null` for a request
   * that named none (which means the default league). */
  bundleLeagueIds(): (string | null)[] {
    return this.bundleUrls.map((href) =>
      new URL(href).searchParams.get('league_id'),
    )
  }
}
