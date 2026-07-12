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

  get dialog(): Locator {
    return this.page.getByRole('dialog')
  }

  get nameInput(): Locator {
    return this.dialog.getByLabel(/^Name/)
  }

  get postalInput(): Locator {
    return this.dialog.getByLabel('Postal')
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

  /** Open the dialog and type a name — the two steps every case below shares. */
  async openWithName(name: string) {
    await this.newTournamentButton.click()
    await expect(this.dialog).toBeVisible()
    await this.nameInput.fill(name)
  }
}
