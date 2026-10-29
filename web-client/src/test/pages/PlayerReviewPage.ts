import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderRoute, type AppRouter } from '../renderRoute'

export type ReviewAction =
  | 'Yes, this is me'
  | 'Someone else played'
  | 'Review later'
  | 'I manage this player'
  | 'Remove from my account'
  | 'Back'

// Page object for "Is this you?": the review page that asks about one player
// at a time, and the reminder on Home that links to it. Mock the account with
// mockVerifiedAccount() from ../server first.
export class PlayerReviewPage {
  // `/?signed_in=1` is Home right after a sign-in.
  static async render(
    path: '/' | '/?signed_in=1' | '/review-players' = '/review-players',
  ): Promise<PlayerReviewPage> {
    const page = new PlayerReviewPage(await renderRoute(path))
    await page.settle()
    return page
  }

  readonly router: AppRouter

  constructor(router: AppRouter) {
    this.router = router
  }

  // The router's current path and query, such as `/review-players`.
  get href(): string {
    return this.router.state.location.href
  }

  get text(): string {
    return document.body.textContent ?? ''
  }

  get heading(): HTMLElement {
    return screen.getByRole('heading', { level: 1 })
  }

  // Waits for the review's question, after a navigation that loads the
  // page's chunk.
  findQuestion(): Promise<HTMLElement> {
    return screen.findByRole('heading', { level: 1, name: /^(Is this you|Do you manage)/ })
  }

  // "Player N of M", or null when only one player waits.
  get counter(): string | null {
    return screen.queryByText(/^Player \d+ of \d+$/)?.textContent ?? null
  }

  // The answer buttons and the line about what "Yes" does.
  get answers(): HTMLElement {
    return screen.getByRole('group', { name: 'Your answer' })
  }

  button(name: ReviewAction): HTMLElement {
    return within(this.answers).getByRole('button', { name })
  }

  // The confirmation of the last answer, while more players remain.
  get notice(): string | null {
    return within(this.answers).queryByRole('status')?.textContent ?? null
  }

  // The toasts on screen, by their text.
  get toasts(): string[] {
    return [...document.querySelectorAll('.fm-toast__msg')].map((toast) => toast.textContent ?? '')
  }

  // The reminder's title on Home, such as "2 players to review", or null.
  get reminderTitle(): string | null {
    return document.querySelector('.fm-alert__title')?.textContent ?? null
  }

  get reviewLink(): HTMLElement {
    return screen.getByRole('link', { name: /^Review players?$/ })
  }

  // Clicks `name` and waits for its request and the navigation.
  async click(name: ReviewAction): Promise<void> {
    await userEvent.click(this.button(name))
    await this.settle()
  }

  async review(): Promise<void> {
    await userEvent.click(this.reviewLink)
    await this.findQuestion()
    await this.settle()
  }

  // Lets the requests, the navigations and the focus moves finish.
  async settle(): Promise<void> {
    for (let tick = 0; tick < 5; tick++) {
      await new Promise((resolve) => setTimeout(resolve))
    }
  }
}
