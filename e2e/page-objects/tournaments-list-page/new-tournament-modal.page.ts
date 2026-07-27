import { Locator, Page } from '@playwright/test'

/**
 * The "New tournament" dialog on the tournaments list page — the only surface in
 * the web app that CREATES a tournament.
 *
 * Its venue block is six boxes an organizer may simply leave alone, and that is a
 * load-bearing affordance rather than an omission: a tournament may have **no
 * venue at all** (CONTEXT.md, "Venue"), and this form has no other gesture that
 * means it. Leaving every box blank is how a browser organizer says "the room is
 * not booked yet" or "this one is at my house and its address is not going on a
 * public map" — so `fillName` deliberately touches nothing else, and the spec's
 * whole point is what the server does with that submission.
 *
 * Locators are keyed on what the organizer reads (the box's `<label>`, the
 * button's text), never on an app import.
 */
export class NewTournamentModalPage {
  constructor(private readonly page: Page) {}

  /** The dialog itself — the scope every control below is resolved inside, so a
   * same-named control on the list page behind it can never be picked up. */
  get dialog(): Locator {
    return this.page.getByRole('dialog')
  }

  /** The one required box. Anchored to the start of the label so it cannot also
   * match "Venue name", whose label likewise contains "name". */
  get nameInput(): Locator {
    return this.dialog.getByLabel(/^Name/)
  }

  /** The first of the five venue boxes. The spec never fills it — it exists here
   * so a spec can assert the venue block is genuinely present and genuinely
   * empty, which is what makes "created with no venue" a statement about a form
   * the organizer left blank rather than about a form that had no venue fields. */
  get venueInput(): Locator {
    return this.dialog.getByLabel('Venue name')
  }

  get createButton(): Locator {
    return this.dialog.getByRole('button', { name: 'Create tournament' })
  }

  /** The dialog's refusal banner — where every failure the form cannot pin to one
   * box lands (a 422, a 403, the coded 409 an unlocatable address used to raise).
   * A spec asserts its ABSENCE: before #1206 an all-blank venue reached the
   * geocoder, resolved to zero candidates, and put a "we couldn't locate that
   * address" refusal right here. */
  get errorBanner(): Locator {
    return this.page.getByTestId('new-tournament-error')
  }
}
