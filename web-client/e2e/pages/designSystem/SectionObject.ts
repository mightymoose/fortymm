import type { Locator, Page } from '@playwright/test'

// One section of the design system gallery, on the app's page or the
// reference's: its h2, its lead line and its examples, found by the test ids
// the reference's TESTING.md lists. The app's page carries the same ids.
export class SectionObject {
  readonly page: Page
  readonly testId: string
  readonly region: Locator
  readonly heading: Locator
  readonly lead: Locator

  constructor(page: Page, id: string) {
    this.page = page
    this.testId = `section-${id}`
    this.region = page.getByTestId(this.testId)
    this.heading = this.region.getByRole('heading', { level: 2 })
    // The first paragraph: the examples have paragraphs too.
    this.lead = this.region.getByRole('paragraph').first()
  }

  // The example with the test id `testId`, e.g. `ex-variants`.
  protected example(testId: string): Locator {
    return this.region.getByTestId(testId)
  }
}
