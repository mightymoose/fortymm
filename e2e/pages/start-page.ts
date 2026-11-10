import type { Locator, Page } from '@playwright/test'

// The web client's start page, at /.
export class StartPage {
  readonly heading: Locator
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
    this.heading = page.getByRole('heading', { name: 'Get started' })
  }

  counter(count: number): Locator {
    return this.page.getByRole('button', { name: `Count is ${count}` })
  }
}
