import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderRoute, type AppRouter } from '../renderRoute'

export type ReviewAction =
  | 'Yes, this is me'
  | 'Someone else played'
  | 'Review later'
  | 'I manage this player'
  | 'Remove from my account'
  | 'Keep as a separate player'
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

  // The question, or null while the players load.
  get queryHeading(): HTMLElement | null {
    return screen.queryByRole('heading', { level: 1 })
  }

  get wordmark(): HTMLElement {
    return screen.getByRole('img', { name: 'FortyMM' })
  }

  // Waits for the review's question, after a navigation that loads the
  // page's chunk.
  findQuestion(): Promise<HTMLElement> {
    return screen.findByRole('heading', { level: 1, name: /^(Is this you|Do you manage|Which player)/ })
  }

  // "Player N of M", or null when only one player waits.
  get counter(): string | null {
    return screen.queryByText(/^Player \d+ of \d+$/)?.textContent ?? null
  }

  // The answer buttons and the line about what "Yes" does.
  get answers(): HTMLElement {
    return screen.getByRole('group', { name: 'Your answer' })
  }

  // An answer, or Back, which "Which player?" keeps apart from the answers.
  button(name: ReviewAction): HTMLElement {
    return screen.getByRole('button', { name })
  }

  // An answer, or null when the page doesn't offer it.
  queryButton(name: ReviewAction): HTMLElement | null {
    return screen.queryByRole('button', { name })
  }

  // The button on "Which player?" that merges the player into the managed
  // player named `displayName`.
  target(displayName: string): HTMLElement {
    return within(this.answers).getByRole('button', { name: displayName })
  }

  // The names of the players that "Which player?" offers.
  get targets(): string[] {
    return within(this.answers)
      .getAllByRole('button')
      .map((button) => button.textContent ?? '')
      .filter((name) => name !== 'Keep as a separate player')
  }

  // The match preview under "Is this you?".
  get matchPreview(): HTMLElement {
    return screen.getByRole('region', { name: 'Recent matches' })
  }

  // The confirmation of the last answer, while more players remain.
  get notice(): string | null {
    return within(this.answers).queryByRole('status')?.textContent ?? null
  }

  // The toasts on screen, by their text.
  get toasts(): string[] {
    return [...document.querySelectorAll('.fm-toast__msg')].map((toast) => toast.textContent ?? '')
  }

  // Whether the review shows its skeleton while the players load.
  get loading(): boolean {
    return screen.queryByText('Loading players') !== null
  }

  // The alert that says the players didn't load, found by its title, or
  // null.
  loadError(title: string): HTMLElement | null {
    return screen.queryByRole('alert', { name: title })
  }

  // Clicks a load error's Try again. React shows the skeleton for a while
  // after it, so wait with findQuestion().
  async tryAgain(alert: HTMLElement): Promise<void> {
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
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

  // Merges the player into `displayName` on "Which player?", and waits as
  // click() does.
  async choose(displayName: string): Promise<void> {
    await userEvent.click(this.target(displayName))
    await this.settle()
  }

  // Clicks `name` twice before React renders again, as a quick double
  // click can, then waits as click() does.
  async clickTwiceAtOnce(name: ReviewAction): Promise<void> {
    const button = this.button(name)
    fireEvent.click(button)
    fireEvent.click(button)
    await this.settle()
  }

  // Clicks `name` as the second click of a double click, after the first
  // one's answer came back and the page moved on.
  async clickAgainInDoubleClick(name: ReviewAction): Promise<void> {
    fireEvent.click(this.button(name), { detail: 2 })
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
