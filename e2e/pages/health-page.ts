import type { Locator, Page } from '@playwright/test'

// The web client's health page, at /health.
export class HealthPage {
  readonly healthy: Locator
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
    this.healthy = page.getByRole('heading', { name: 'The API is healthy' })
  }

  async open() {
    await this.page.goto('/health')
  }
}
