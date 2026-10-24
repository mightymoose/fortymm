import type { Locator, Page } from '@playwright/test'
import { ButtonsSection } from './designSystem/ButtonsSection.ts'

// The design system gallery, as the app's /design-system or the reference
// draws it: the page chrome, plus one object per section for its examples.
// Both pages open in the reference's test mode (see its TESTING.md).
export abstract class GalleryPage {
  readonly page: Page
  readonly title: Locator
  readonly intro: Locator
  readonly buttons: ButtonsSection

  constructor(page: Page) {
    this.page = page
    this.title = page.getByRole('heading', { level: 1 })
    // The paragraph right after the title.
    this.intro = page.getByRole('paragraph').first()
    this.buttons = new ButtonsSection(page)
  }

  // The page's URL with `query` added.
  protected abstract url(query: string): string

  // Opens the page in test mode: no transitions, animations or text caret.
  // With `only`, it shows just the element with that test id, flush
  // top-left with 24px padding, so it starts on a whole pixel on both pages
  // whatever comes before it.
  async goto(only?: string): Promise<void> {
    await this.page.goto(
      this.url(only ? `?test&only=${encodeURIComponent(only)}` : '?test'),
    )
    // Set once the fonts have loaded and two frames have painted.
    await this.page.locator('html[data-fm-ready="true"]').waitFor()
  }
}
