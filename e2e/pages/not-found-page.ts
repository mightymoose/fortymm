import type { Locator, Page } from '@playwright/test'

// The web client's page for a URL that matches no route.
export class NotFoundPage {
  readonly heading: Locator
  readonly linkToStart: Locator
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
    this.heading = page.getByRole('heading', { name: 'Page not found' })
    this.linkToStart = page.getByRole('link', { name: 'Go to the start page' })
  }

  // Loads the URL directly, the way a typed address or a reload does, so the
  // hosting answers the request, not the router in an already-open page.
  async open(path: string) {
    await this.page.goto(path)
  }
}
