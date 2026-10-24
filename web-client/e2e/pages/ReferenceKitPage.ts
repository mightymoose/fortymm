import { fileURLToPath } from 'node:url'
import type { Locator, Page } from '@playwright/test'

// The design system's component gallery, opened straight from references/
// in its test mode (see its TESTING.md): no transitions or animations, no
// text caret. The app's design system page is built to match it.
const galleryUrl = new URL(
  '../../../references/design-system/ui_kits/components/index.html?test',
  import.meta.url,
).href

// The app's fonts, where its self-hosted Space Grotesk stylesheet lives.
const fontsDir = new URL('../../src/assets/fonts/', import.meta.url)

export class ReferenceKitPage {
  readonly page: Page
  readonly title: Locator
  readonly intro: Locator

  constructor(page: Page) {
    this.page = page
    this.title = page.getByRole('heading', { level: 1 })
    // The paragraph right after the title.
    this.intro = page.getByRole('paragraph').first()
  }

  async goto(): Promise<void> {
    // The gallery embeds its display and mono fonts but loads Space Grotesk
    // from Google Fonts. Serve it the app's own Space Grotesk stylesheet
    // instead, unchanged, so both pages load the same font files the same
    // way, offline. The stylesheet's relative URLs resolve to Google Fonts'
    // host too, so the font files come through this route as well.
    await this.page.route('https://fonts.googleapis.com/**', (route) => {
      const file = new URL(route.request().url()).pathname.slice(1)
      return route.fulfill({
        path: fileURLToPath(
          new URL(file.endsWith('.woff2') ? file : 'space-grotesk.css', fontsDir),
        ),
        // The gallery is opened from disk, so its fonts are cross-origin.
        headers: { 'Access-Control-Allow-Origin': '*' },
      })
    })
    await this.page.goto(galleryUrl)
    // kit.js sets this once the fonts have loaded, every component is set
    // up and two frames have painted.
    await this.page.locator('html[data-fm-ready="true"]').waitFor()
  }

  // Swaps in other title text, so the title can be compared pixel for pixel
  // with a page that says something else.
  async setTitleText(title: string): Promise<void> {
    await this.title.evaluate((el, text) => (el.textContent = text), title)
  }
}
