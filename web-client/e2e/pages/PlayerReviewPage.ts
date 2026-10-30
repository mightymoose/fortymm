import type { Locator, Page } from '@playwright/test'
import type { components } from '../../src/api/schema.d.ts'

export type ReviewAnswer = 'yes' | 'no' | 'not_mine'

// Page object for "Is this you?", the page that reviews one player at a time
// after a sign-in.
export class PlayerReviewPage {
  readonly page: Page
  // The question, such as "Is this you?".
  readonly question: Locator
  // The question with the player it asks about.
  readonly content: Locator
  // The answer buttons, with the line about what "Yes" does.
  readonly answers: Locator

  constructor(page: Page) {
    this.page = page
    this.question = page.getByRole('heading', { level: 1 })
    this.content = page.getByRole('main')
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

  // Says the player on screen is `displayName`, a player the account
  // already manages, through "Which player?". The two players merge.
  async mergeInto(displayName: string): Promise<void> {
    await this.button('Someone else played').click()
    await this.button('I manage this player').click()
    await this.page.getByRole('heading', { level: 1, name: 'Which player?' }).waitFor()
    await this.button(displayName).click()
  }

  // The account's players, from GET /v1/account/players with the browser's
  // cookies.
  async players(): Promise<components['schemas']['AccountPlayer'][]> {
    const response = await this.page.request.get('/api/v1/account/players')
    if (!response.ok()) throw new Error(`GET /api/v1/account/players answered ${response.status()}`)
    const body: components['schemas']['AccountPlayersResponse'] = await response.json()
    return body.data
  }

  // Leaves for Home without an answer.
  async reviewLater(): Promise<void> {
    await this.button('Review later').click()
  }

  private button(name: string): Locator {
    return this.answers.getByRole('button', { name })
  }
}
