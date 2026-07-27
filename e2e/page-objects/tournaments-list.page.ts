import { Locator, Page } from '@playwright/test'

import { NewTournamentModalPage } from './tournaments-list-page/new-tournament-modal.page'

/**
 * The tournaments list page (`/tournaments`) — scoped to the one surface a spec
 * drives here: the "New tournament" action and the dialog it opens
 * (`NewTournamentModalPage`, composed the way `DashboardPage.userMenu` is).
 *
 * The action is owner-gated (`tournament.create`), so a caller must hold the
 * "Beta tester" role before this page offers it at all — see
 * `support/rbac-grant.ts`.
 */
export class TournamentsListPage {
  constructor(private readonly page: Page) {}

  static async navigateTo(page: Page): Promise<TournamentsListPage> {
    await page.goto('/tournaments')
    return new TournamentsListPage(page)
  }

  /** The header's "New tournament" button. `.first()` because the empty state
   * offers a second button by the same name when the list filters to nothing —
   * both open the same dialog, and this suite shares a stack whose tournament
   * count is not a fact any one spec owns. */
  get newTournamentButton(): Locator {
    return this.page.getByRole('button', { name: 'New tournament' }).first()
  }

  /** Open the create dialog and return its page object. */
  async openNewTournament(): Promise<NewTournamentModalPage> {
    await this.newTournamentButton.click()
    return new NewTournamentModalPage(this.page)
  }
}
