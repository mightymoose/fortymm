import type { Locator, Page } from '@playwright/test'

// One section of the design system page: its region, its h2 and its lead
// line. Each section's own object adds its component cards.
export class SectionObject {
  readonly page: Page
  readonly region: Locator
  readonly heading: Locator
  readonly lead: Locator

  constructor(page: Page, title: string) {
    this.page = page
    this.region = page.getByRole('region', { name: title })
    this.heading = this.region.getByRole('heading', { level: 2 })
    // The first paragraph: the cards in the section have paragraphs too.
    this.lead = this.region.getByRole('paragraph').first()
  }
}
