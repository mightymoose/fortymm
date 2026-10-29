import type { Locator, Page } from '@playwright/test'

export type ReviewAnswer = 'yes' | 'no' | 'not_mine'

// Page object for "Is this you?", the page that reviews one player at a time
// after a sign-in.
export class PlayerReviewPage {
  readonly page: Page
  // The question, such as "Is this you?".
  readonly question: Locator
  // The answer buttons, with the line about what "Yes" does.
  readonly answers: Locator

  constructor(page: Page) {
    this.page = page
    this.question = page.getByRole('heading', { level: 1 })
    this.answers = page.getByRole('group', { name: 'Your answer' })
  }

  // Gives `answer` for the player on screen. "No" and "Not mine" go through
  // "Someone else played" first.
  async answer(answer: ReviewAnswer): Promise<void> {
    if (answer === 'yes') {
      await this.button('Yes, this is me').click()
      return
    }
    await this.button('Someone else played').click()
    await this.button(answer === 'no' ? 'I manage this player' : 'Remove from my account').click()
  }

  // Leaves for Home without an answer.
  async reviewLater(): Promise<void> {
    await this.button('Review later').click()
  }

  private button(name: string): Locator {
    return this.answers.getByRole('button', { name })
  }
}
