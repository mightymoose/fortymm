import type { Locator, Page } from '@playwright/test'

// The web client's health page, at /health.
export class HealthPage {
  readonly healthy: Locator
  readonly unknown: Locator
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
    this.healthy = page.getByRole('heading', { name: 'The API is healthy' })
    this.unknown = page.getByRole('heading', {
      name: 'The API’s health is unknown',
    })
  }

  async open() {
    await this.page.goto('/health')
  }
}
