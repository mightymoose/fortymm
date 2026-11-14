import type { Locator, Page } from '@playwright/test'

// The web client's start page, at /. It is blank; its one element is a
// heading for screen readers, which the app renders, so seeing it means the
// bundle ran.
export class StartPage {
  readonly heading: Locator

  constructor(page: Page) {
    this.heading = page.getByRole('heading', { level: 1, name: 'FortyMM' })
  }
}
