import type { Locator, Page } from '@playwright/test'

// Page object for the design system page in the Playwright suite.
export class DesignSystemPage {
  readonly page: Page
  readonly header: Locator
  readonly title: Locator
  readonly subtitle: Locator

  constructor(page: Page) {
    this.page = page
    this.header = page.getByRole('banner')
    this.title = this.header.getByRole('heading', { level: 1 })
    this.subtitle = this.header.locator('.sub')
  }

  async goto(): Promise<void> {
    await this.page.goto('/design-system')
  }
}
