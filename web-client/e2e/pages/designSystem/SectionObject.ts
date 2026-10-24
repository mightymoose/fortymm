import type { Locator, Page } from '@playwright/test'

// One section of the design system page: its region, its h2 and its lead
// line. Each section's own object adds its examples.
export class SectionObject {
  readonly page: Page
  readonly region: Locator
  readonly heading: Locator
  readonly lead: Locator

  constructor(page: Page, title: string) {
    this.page = page
    this.region = page.getByRole('region', { name: title, exact: true })
    this.heading = this.region.getByRole('heading', { level: 2 })
    // The first paragraph: the examples have paragraphs too.
    this.lead = this.region.getByRole('paragraph').first()
  }

  // The example titled `title`.
  protected example(title: string): Locator {
    return this.region.getByRole('article', { name: title, exact: true })
  }
}
