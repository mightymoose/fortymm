import { Locator, Page } from '@playwright/test'

/**
 * The notifications feed (`/notifications`) — scoped to what the
 * solver-schedule spec proves there: that a **match call** reached its
 * recipient as a real in-app notification (ADR "the schedule is solved; the
 * call is pinned": calling pins the fixture and tells both players, in one
 * transaction).
 */
export class NotificationsPage {
  constructor(private readonly page: Page) {}

  static async navigateTo(page: Page): Promise<NotificationsPage> {
    await page.goto('/notifications')
    return new NotificationsPage(page)
  }

  /** The match-called notification's title, by the table label the call
   * promised: `You're up soon — {table}` (`match_called_message`). Its
   * presence in the recipient's feed IS the "this fixture was called and its
   * players were told" fact, observed through the UI. */
  callNotice(tableLabel: string): Locator {
    return this.page.getByText(`You're up soon — ${tableLabel}`).first()
  }

  /** A *moved* correction's title (`match_call_moved_message`): `Your match moved
   * to {table}`. Asserted **absent** by the specs whose whole point is that a
   * called player is never re-pinged (#1661). */
  get movedNotice(): Locator {
    return this.page.getByText(/^Your match moved to /)
  }

  /** The notice a player receives when someone else — the tournament director, or
   * an opponent on an unrated match — recorded a final result on their match
   * without their acceptance (#1661 item 4, #1585, #1650). */
  get resultRecordedNotice(): Locator {
    return this.page.getByText('Your match result was recorded').first()
  }
}
