import type { Locator, Page } from '@playwright/test'

// Page object for the design system page in the Playwright suite: the page
// chrome, plus one object per section for its examples.
export class DesignSystemPage {
  readonly page: Page
  readonly loadingScreen: Locator
  readonly title: Locator
  readonly intro: Locator

  constructor(page: Page) {
    this.page = page
    this.loadingScreen = page.getByRole('status', { name: 'Loading FortyMM' })
    this.title = page.getByRole('heading', { level: 1 })
    // The paragraph right after the title.
    this.intro = page.getByRole('paragraph').first()
  }

  // Opens the page. It shows no loading screen, so there's nothing to wait
  // out.
  async goto(): Promise<void> {
    await this.page.goto('/design-system')
  }
}
