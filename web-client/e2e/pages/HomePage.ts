import type { Locator, Page } from '@playwright/test'
import { loadingScreen, waitForLoadingScreen } from './loadingScreen.ts'

// Page object for the home page in the Playwright suite.
export class HomePage {
  readonly page: Page
  readonly title: Locator
  readonly loadingScreen: Locator

  constructor(page: Page) {
    this.page = page
    this.title = page.getByRole('heading', { level: 1 })
    this.loadingScreen = loadingScreen(page)
  }

  // Opens the page once the loading screen over it has gone.
  async goto(): Promise<void> {
    await this.open()
    await waitForLoadingScreen(this.page)
  }

  // Opens the page without waiting for the loading screen.
  async open(): Promise<void> {
    await this.page.goto('/')
  }
}
