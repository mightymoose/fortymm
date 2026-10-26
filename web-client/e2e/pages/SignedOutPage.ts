import type { Locator, Page } from '@playwright/test'

// Page object for the page after sign-out in the Playwright suite.
export class SignedOutPage {
  readonly page: Page
  readonly title: Locator
  readonly signInLink: Locator
  readonly guestLink: Locator

  constructor(page: Page) {
    this.page = page
    this.title = page.getByRole('heading', { level: 1 })
    this.signInLink = page.getByRole('link', { name: 'Sign in' })
    this.guestLink = page.getByRole('link', { name: 'Play as a guest' })
  }
}
