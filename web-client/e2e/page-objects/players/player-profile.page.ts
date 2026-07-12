import type { Locator, Page } from '@playwright/test'

import { PlayerStore, type PlayerStoreSeed } from './player-store'

/**
 * Page object for `/players/$userId` and its `/matches` sub-route — the profile,
 * its match history, and the two boundary states they share (`PlayerNotFound`
 * and `PlayerRouteError`).
 *
 * Holds the `PlayerStore` that stubs the network, since every navigation here
 * needs it installed first (MSW is off in this suite).
 */
export class PlayerProfilePage {
  readonly store: PlayerStore

  private constructor(
    readonly page: Page,
    store: PlayerStore,
  ) {
    this.store = store
  }

  /** Install the stubs. Navigate afterwards with `openProfile` / `openHistory`. */
  static async create(
    page: Page,
    seed: PlayerStoreSeed = {},
  ): Promise<PlayerProfilePage> {
    const store = new PlayerStore(seed)
    await store.install(page)
    return new PlayerProfilePage(page, store)
  }

  openProfile(playerId: string) {
    return this.page.goto(`/players/${playerId}`)
  }

  openHistory(playerId: string) {
    return this.page.goto(`/players/${playerId}/matches`)
  }

  /* ---------------- the app shell ---------------- */

  /**
   * The shell's landmarks. The player not-found body is rendered *inside* the
   * `_app` layout, which already IS an `AppShell` — so a not-found component
   * that wrapped itself in another one would double every landmark here. A spike
   * measured exactly that (two `<main>`s) from the naive implementation, which is
   * why these are counted rather than merely found.
   */
  get mainLandmarks(): Locator {
    return this.page.locator('main')
  }

  get sidebars(): Locator {
    return this.page.getByRole('complementary', { name: 'Main navigation' })
  }

  get headers(): Locator {
    return this.page.locator('header.app-shell__topbar')
  }

  /* ---------------- the loaded profile ---------------- */

  /** The hero's `<h1>` — its accessible name is the bare username (the trailing
   * brand dot is `aria-hidden`). */
  heading(username: string): Locator {
    return this.page.getByRole('heading', { level: 1, name: username, exact: true })
  }

  /** The head-to-head card. Named "Head-to-head" on somebody else's profile. */
  get headToHead(): Locator {
    return this.page.getByRole('region', { name: 'Head-to-head' })
  }

  get recentMatches(): Locator {
    return this.page.getByRole('region', { name: 'Recent matches' })
  }

  /** A frequent-opponent name in the head-to-head card — a link since #1005. */
  frequentOpponentLink(username: string): Locator {
    return this.headToHead.getByRole('link', { name: username, exact: true })
  }

  /** An opponent name in the Recent-matches card — a link since #1005. */
  recentOpponentLink(username: string): Locator {
    return this.recentMatches.getByRole('link', { name: username, exact: true })
  }

  /* ---------------- the match history ---------------- */

  /** The pager's readout — "Showing 1–2 of 2 matches" (#1006). */
  get footerInfo(): Locator {
    return this.page.locator('.footer-info')
  }

  get pager(): Locator {
    return this.page.getByRole('navigation')
  }

  pagerButton(name: 'First page' | 'Previous page' | 'Next page' | 'Last page'): Locator {
    return this.page.getByRole('button', { name })
  }

  get historyEmptyState(): Locator {
    return this.page.getByText('No matches yet', { exact: true })
  }

  /* ---------------- the boundary states ---------------- */

  get notFoundHeading(): Locator {
    return this.page.getByRole('heading', { name: 'Player not found.' })
  }

  get backToPlayersLink(): Locator {
    return this.page.getByRole('link', { name: 'Back to players' })
  }

  /** The 5xx / network branch — designed, styled, and always retryable (#1001). */
  get errorState(): Locator {
    return this.page.locator('.md-error-state')
  }

  get errorHeading(): Locator {
    // The apostrophe is a right single quote in the source copy.
    return this.page.getByRole('heading', { name: 'Couldn’t load this player.' })
  }

  get tryAgainButton(): Locator {
    return this.page.getByRole('button', { name: 'Try again' })
  }

  /** TanStack Router's generic fallback — the screen a mis-wired `notFound()`
   * escapes to, and therefore the thing #1001's fix must never show. */
  get genericRouterError(): Locator {
    return this.page.getByText('Something went wrong!')
  }

  /* ---------------- the players list (the recovery target) ---------------- */

  /** A row of `/players`. The list renders its rows as `role="link"` cells. */
  playersListRow(username: string): Locator {
    return this.page.getByRole('link', { name: `Open ${username} profile` })
  }
}
