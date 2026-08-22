import { expect, type Locator, type Page } from '@playwright/test'

import { PERM } from '../../../src/lib/permissions'
import {
  TournamentsStore,
  type TournamentsStoreOptions,
} from './tournaments-store'

/**
 * Page object for the tournament **list** page and its "New tournament" dialog.
 *
 * Everything is keyed on what the organizer reads (the button's label, the box's
 * `<label>`), never on an app import: a page object that pulled its strings out of the
 * component could not notice them changing — which matters more here than usual, since
 * what this dialog *says* when a save is refused is the whole subject of the spec.
 */
export class TournamentsListPage {
  constructor(private readonly page: Page) {}

  /** Install the stateful stub and load `/tournaments`, waiting for the page to be
   * really on screen (its "New tournament" action) — an assertion about a dialog that
   * "is not open" passes vacuously against a page that has not rendered).
   *
   * `tournament.create` is in the default permissions here (it is not in the store's,
   * whose specs are about *entering*): without it, the list rightly hides the action
   * this page object exists to press. */
  static async navigateTo(page: Page, options: TournamentsStoreOptions = {}) {
    const store = new TournamentsStore({
      permissions: [PERM.TOURNAMENT_VIEW, PERM.TOURNAMENT_CREATE],
      ...options,
    })
    await store.install(page)
    await page.goto('/tournaments')

    const pom = new TournamentsListPage(page)
    await expect(pom.newTournamentButton).toBeVisible()
    return { pom, store }
  }

  /** The list's header action. (The empty state offers a second button by the same
   * name, so this is scoped to the heading — the seed always has one tournament, but
   * a filtered-to-nothing list must not make this locator ambiguous.) */
  get newTournamentButton(): Locator {
    return this.page.getByRole('button', { name: 'New tournament' }).first()
  }

  /** The list's search box, by its accessible name. The box holds its own raw
   * text buffer and only SEEDS from the URL, so what it reads after the URL moves
   * underneath it is the whole subject of the url-resync spec. */
  get searchInput(): Locator {
    return this.page.getByRole('textbox', { name: 'Search tournaments by name' })
  }

  /** A status-filter tab (`All`, `Live`, ...). The active one carries
   * `aria-selected="true"`, which is what `toHaveAttribute` reads. */
  statusTab(label: string): Locator {
    return this.page.getByRole('tab', { name: label, exact: true })
  }

  /** A tournament card's full-card open target, keyed on the name the organizer
   * reads — so "the card is back" means the grid really stopped filtering. */
  card(name: string): Locator {
    return this.page.getByRole('button', { name, exact: true })
  }

  /** The app shell's own "Tournaments" entry. It is `to: '/tournaments'` with no
   * search, so clicking it while a filter is active is a SAME-ROUTE navigation:
   * the URL drops `q`/`status` and the list page never unmounts. */
  get sidebarTournamentsLink(): Locator {
    return this.page
      .locator('#app-shell-sidebar')
      .getByRole('link', { name: 'Tournaments' })
  }

  get dialog(): Locator {
    return this.page.getByRole('dialog')
  }

  get nameInput(): Locator {
    return this.dialog.getByLabel(/^Name/)
  }

  get postalInput(): Locator {
    return this.dialog.getByLabel('Postal')
  }

  get venueInput(): Locator {
    return this.dialog.getByLabel('Venue name')
  }

  /** The shared "Preview location" affordance. Its label flips to "Locating…"
   * while a geocode is in flight, so the name matches both — a locator that
   * matched only the resting label would go "missing" mid-lookup. */
  get previewLocationButton(): Locator {
    return this.dialog.getByRole('button', { name: /Preview location|Locating/ })
  }

  /** The NEUTRAL "add a venue address" hint — what a click with every venue box
   * blank says. Kept distinct from `previewLocationError` on purpose: a blank
   * venue is a valid tournament, not a failure. */
  get previewLocationHint(): Locator {
    return this.page.getByTestId('preview-location-hint')
  }

  /** The DESTRUCTIVE "we couldn't locate that address" alert — the genuine
   * zero-results case, and only that. */
  get previewLocationError(): Locator {
    return this.page.getByTestId('preview-location-error')
  }

  get createButton(): Locator {
    return this.dialog.getByRole('button', { name: 'Create tournament' })
  }

  /** The dialog's refusal banner — where a rejection the form cannot pin to a single
   * box lands. By test id, so a spec can assert what it does NOT say. */
  get errorBanner(): Locator {
    return this.page.getByTestId('new-tournament-error')
  }

  /** A red message under one of the dialog's boxes (the `Field` row's error hint),
   * keyed on the text the organizer reads — since that IS the claim: they were told
   * this, here, in these words. */
  fieldError(message: string): Locator {
    return this.dialog.getByText(message)
  }

  /** Toasts. Here to prove a NEGATIVE that matters: a 500 used to have the toast as its
   * only channel, and QA saw no toast — so the failure said nothing at all. The banner is
   * the channel now, and the spec asserts both halves (the banner is there, and nothing
   * is hiding in a portal). */
  get toasts(): Locator {
    return this.page.locator('[data-sonner-toast]')
  }

  /** EVERY error message anywhere on the page — banner, field hint, toast. What "the app
   * said something" actually means, as opposed to "one locator I chose was populated". */
  get anyErrorText(): Locator {
    return this.page.getByText(/rejected|went wrong|couldn't|cannot|failed/i)
  }

  /** Open the dialog and type a name — the two steps every case below shares. */
  async openWithName(name: string) {
    await this.newTournamentButton.click()
    await expect(this.dialog).toBeVisible()
    await this.nameInput.fill(name)
  }
}
