import type { Locator, Page } from '@playwright/test'

export class HealthPage {
  private readonly page: Page
  // Each side's Core status line, looked up within its own section.
  public readonly apiCore: Locator
  public readonly webCore: Locator
  // Both Core lines, API first then Web client (document order).
  public readonly cores: Locator

  constructor(page: Page) {
    this.page = page
    this.apiCore = page
      .getByRole('region', { name: 'API' })
      .getByRole('status')
      .filter({ hasText: /^Core:/ })
    this.webCore = page.getByRole('region', { name: 'Web client' }).getByRole('status')
    this.cores = this.apiCore.or(this.webCore)
  }

  async goto() {
    await this.page.goto('/health')
  }
}
