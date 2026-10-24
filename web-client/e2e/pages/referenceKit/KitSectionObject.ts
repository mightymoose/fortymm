import type { Locator, Page } from '@playwright/test'

// One section of the reference kit: its h2, its lead line and its component
// cards. The kit's sections have ids but no accessible names, so they aren't
// regions. Its component cards are plain divs, found by their h3.
export class KitSectionObject {
  readonly page: Page
  readonly region: Locator
  readonly heading: Locator
  readonly lead: Locator

  constructor(page: Page, id: string) {
    this.page = page
    this.region = page.locator(`#${id}`)
    this.heading = this.region.getByRole('heading', { level: 2 })
    this.lead = this.region.getByRole('paragraph').first()
  }

  // The component card titled `title`.
  protected card(title: string): Locator {
    return this.region.locator('.comp', {
      has: this.page.getByRole('heading', {
        level: 3,
        name: title,
        exact: true,
      }),
    })
  }
}
