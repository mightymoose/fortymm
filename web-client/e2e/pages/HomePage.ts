import type { Locator, Page } from '@playwright/test'

export type ReviewChoice = 'This is me' | 'I manage this player' | 'Remove from my account'

// Page object for the home page in the Playwright suite.
export class HomePage {
  readonly page: Page
  readonly title: Locator
  // The loading screen the app shows in place of the page on a full page
  // load, until the session starts.
  readonly loadingScreen: Locator
  // The strip that asks a guest to sign in, and its link.
  readonly signInStrip: Locator
  readonly signInLink: Locator
  // The strip that shows a verified account, and its button that signs out.
  readonly accountStrip: Locator
  readonly signOutButton: Locator
  // The topbar's chip that opens the account menu, the menu, and the dialog
  // that asks a guest before it signs out.
  readonly accountButton: Locator
  readonly accountMenu: Locator
  readonly guestSignOutDialog: Locator

  // The reminder of the players still to review, by its title.
  readonly reminder: Locator
  // The "Who is <player>?" dialog.
  readonly review: Locator
  readonly reviewTitle: Locator
  readonly continueButton: Locator

  constructor(page: Page) {
    this.page = page
    this.title = page.getByRole('heading', { level: 1 })
    this.loadingScreen = page.getByRole('status', { name: 'Loading FortyMM' })
    this.signInStrip = page.getByRole('complementary', { name: 'Sign in' })
    this.signInLink = this.signInStrip.getByRole('link', { name: 'Sign in' })
    this.accountStrip = page.getByRole('complementary', { name: 'Your account' })
    this.signOutButton = this.accountStrip.getByRole('button', { name: 'Sign out' })
    this.accountButton = page.getByRole('button', { name: 'Your account' })
    this.accountMenu = page.getByRole('menu', { name: 'Your account' })
    this.guestSignOutDialog = page.getByRole('dialog', {
      name: 'Sign out of this guest account?',
    })
    this.reminder = page.getByText(/^\d+ players? to review$/)
    this.review = page.getByRole('dialog')
    this.reviewTitle = this.review.getByRole('heading', { level: 2 })
    this.continueButton = this.review.getByRole('button', { name: 'Continue' })
  }

  // One of the dialog's answers, such as "This is me".
  choice(label: ReviewChoice): Locator {
    return this.review.getByRole('radio', { name: new RegExp(`^${label}`) })
  }

  // Picks the answer, then Continue.
  async answer(label: ReviewChoice): Promise<void> {
    await this.choice(label).check()
    await this.continueButton.click()
  }

  // The account strip's line that names the account signed in as `email`.
  signedInAs(email: string): Locator {
    return this.accountStrip.getByText(`Signed in as ${email}.`)
  }

  // The topbar's avatar of the player named `displayName`.
  avatar(displayName: string): Locator {
    return this.page.getByRole('img', { name: displayName })
  }

  // Opens the page and waits for the loading screen over it to go.
  async goto(): Promise<void> {
    await this.open()
    await this.title.waitFor()
    await this.loadingScreen.waitFor({ state: 'hidden' })
  }

  // Opens the page without waiting for the loading screen to go.
  async open(): Promise<void> {
    await this.page.goto('/')
  }
}
