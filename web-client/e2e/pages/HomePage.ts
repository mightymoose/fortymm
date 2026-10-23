import type { Locator, Page } from '@playwright/test'

// Page object for the home page in the Playwright suite.
export class HomePage {
  readonly page: Page
  readonly title: Locator
  // The loading screen the app shows in place of the page on a full page
  // load, until the API's health check answers.
  readonly loadingScreen: Locator

  constructor(page: Page) {
    this.page = page
    this.title = page.getByRole('heading', { level: 1 })
    this.loadingScreen = page.getByRole('status', { name: 'Loading FortyMM' })
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
