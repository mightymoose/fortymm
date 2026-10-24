import type { Locator, Page } from '@playwright/test'

// One section of the reference gallery: its h2, its lead line and its
// examples, found by the test ids its TESTING.md lists.
export class KitSectionObject {
  readonly page: Page
  readonly region: Locator
  readonly heading: Locator
  readonly lead: Locator

  constructor(page: Page, id: string) {
    this.page = page
    this.region = page.getByTestId(`section-${id}`)
    this.heading = this.region.getByRole('heading', { level: 2 })
    this.lead = this.region.getByRole('paragraph').first()
  }

  // The example with the test id `ex-<id>`.
  protected example(id: string): Locator {
    return this.region.getByTestId(`ex-${id}`)
  }
}
