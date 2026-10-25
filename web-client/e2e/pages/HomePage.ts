import type { Locator, Page } from '@playwright/test'

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

  constructor(page: Page) {
    this.page = page
    this.title = page.getByRole('heading', { level: 1 })
    this.loadingScreen = page.getByRole('status', { name: 'Loading FortyMM' })
    this.signInStrip = page.getByRole('complementary', { name: 'Sign in' })
    this.signInLink = this.signInStrip.getByRole('link', { name: 'Sign in' })
    this.accountStrip = page.getByRole('complementary', { name: 'Your account' })
    this.signOutButton = this.accountStrip.getByRole('button', { name: 'Sign out' })
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
