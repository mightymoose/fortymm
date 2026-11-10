import type { Locator, Page } from '@playwright/test'

// The screen web-client shows for a URL that matches no route.
export class NotFoundPage {
  readonly heading: Locator

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Page not found' })
  }

  // Loads the URL directly, the way a typed address or a reload does: the
  // server answers the request, not the router in an already-open page.
  async open(path: string) {
    await this.page.goto(path)
  }
}
