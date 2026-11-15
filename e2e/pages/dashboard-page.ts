import type { Locator, Page } from '@playwright/test'

// The web client's dashboard, at /. Its heading is rendered by the app, so
// seeing it means the bundle ran.
export class DashboardPage {
  readonly heading: Locator

  constructor(page: Page) {
    this.heading = page.getByRole('heading', { level: 1, name: 'Dashboard' })
  }
}
