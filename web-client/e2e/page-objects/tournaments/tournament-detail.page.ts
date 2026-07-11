import { expect, type Locator, type Page } from '@playwright/test'

import {
  EVENT,
  TOURNAMENT_ID,
  TournamentsStore,
  type TournamentsStoreOptions,
} from './tournaments-store'

/**
 * Page object for the tournament detail page's **Events tab** (the default tab,
 * so no navigation beyond the URL).
 *
 * Every locator is keyed on the event NAME, because the tab is a list of
 * near-identical cards: a bare `getByRole('button', { name: 'Enter' })` would be
 * ambiguous the moment a second singles event exists, and a count assertion not
 * scoped to a card would happily match a sibling's identical `2 / 64`.
 */
export class TournamentDetailPage {
  constructor(private readonly page: Page) {}

  /** Install the stateful stub, load the page, and wait for the Events tab to be
   * really on screen. That last wait is load-bearing: every "there is no Enter
   * control here" assertion in the spec passes *vacuously* against a page that
   * has not rendered yet. */
  static async navigateTo(page: Page, options: TournamentsStoreOptions = {}) {
    const store = new TournamentsStore(options)
    await store.install(page)
    await page.goto(`/tournaments/${TOURNAMENT_ID}`)

    const pom = new TournamentDetailPage(page)
    await expect(pom.eventCard(EVENT.JOURNEY)).toBeVisible()
    return { pom, store }
  }

  /** One event's row card. The stretched open-target button is a *sibling* of
   * the `Card` (that is what keeps it out of the entrants list and off the Enter
   * control), so it is deliberately NOT inside this locator. */
  eventCard(eventName: string): Locator {
    return this.page.locator('[data-slot=card]').filter({ hasText: eventName })
  }

  enterButton(eventName: string): Locator {
    return this.page.getByRole('button', { name: `Enter ${eventName}` })
  }

  withdrawButton(eventName: string): Locator {
    return this.page.getByRole('button', { name: `Withdraw from ${eventName}` })
  }

  /** The roster `<ul>`. Absent (count 0) in the `empty` and `entry-closed`
   * states, which render a paragraph instead. */
  entrantsList(eventName: string): Locator {
    return this.page.getByRole('list', { name: `Entrants in ${eventName}` })
  }

  /** The full-card overlay that opens the editor. Its accessible name is
   * `Edit {event}` for an owner, `View {event}` otherwise. */
  openEditorOverlay(eventName: string): Locator {
    return this.page.getByRole('button', { name: `Edit ${eventName}` })
  }

  /** The event editor — a Sheet, i.e. a `role="dialog"`. The one thing clicking
   * Enter must NOT do. */
  get eventEditor(): Locator {
    return this.page.getByRole('dialog')
  }

  /** The tournament-level "Entries" hero stat: the sum of every event's derived
   * count. It is a `Card` like the event rows are, so it is identified as "the
   * card that says Entries but is not an event card" — event cards all carry a
   * Time slot column. */
  get heroEntries(): Locator {
    return this.page
      .locator('[data-slot=card]')
      .filter({ hasText: 'Entries' })
      .filter({ hasNotText: 'Time slot' })
  }

  /** Toasts — the app's error channel. The happy journey must raise none. */
  get toasts(): Locator {
    return this.page.locator('[data-sonner-toast]')
  }

  /** Assert an event card's `entered / max_players` numerals, scoped to the card
   * so a sibling event's identical figures cannot satisfy it. */
  async expectEntryCount(eventName: string, entered: number, max: number) {
    await expect(this.eventCard(eventName)).toContainText(
      new RegExp(`${entered}\\s*/\\s*${max}`),
    )
  }
}
