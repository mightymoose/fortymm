import type { Locator, Page } from '@playwright/test'

// Page object for the design system page in the Playwright suite.
export class DesignSystemPage {
  readonly page: Page
  readonly title: Locator

  constructor(page: Page) {
    this.page = page
    this.title = page.getByRole('heading', { level: 1 })
  }

  async goto(): Promise<void> {
    await this.page.goto('/design-system')
  }
}
