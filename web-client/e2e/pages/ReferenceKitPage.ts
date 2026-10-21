import type { Locator, Page } from '@playwright/test'

// The design system's shadcn/ui kit page, opened straight from references/.
// Its page chrome is what the app's design system page is built to match.
const kitUrl = new URL(
  '../../../references/fortymm-design-system/ui_kits/shadcn/index.html',
  import.meta.url,
).href

export class ReferenceKitPage {
  readonly page: Page
  readonly header: Locator
  readonly title: Locator
  readonly subtitle: Locator

  constructor(page: Page) {
    this.page = page
    this.header = page.getByRole('banner')
    this.title = this.header.getByRole('heading', { level: 1 })
    this.subtitle = this.header.locator('.sub')
  }

  async goto(): Promise<void> {
    // The kit embeds its display and mono fonts; skip the Google Fonts
    // request for Space Grotesk so the page renders offline and the same way
    // every run.
    await this.page.route('https://fonts.googleapis.com/**', (route) =>
      route.abort(),
    )
    await this.page.goto(kitUrl)
  }

  // Swaps in other header copy, so the header can be compared pixel for
  // pixel with a page that says something else.
  async setHeaderText(title: string, subtitle: string): Promise<void> {
    await this.title.evaluate((el, text) => (el.textContent = text), title)
    await this.subtitle.evaluate((el, text) => (el.textContent = text), subtitle)
  }
}
