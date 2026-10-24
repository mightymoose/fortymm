import { fileURLToPath } from 'node:url'
import type { Locator, Page } from '@playwright/test'
import { KitDataDisplaySection } from './referenceKit/KitDataDisplaySection.ts'
import { KitFeedbackSection } from './referenceKit/KitFeedbackSection.ts'
import { KitFormsSection } from './referenceKit/KitFormsSection.ts'
import { KitNavigationSection } from './referenceKit/KitNavigationSection.ts'
import { KitOverlaysSection } from './referenceKit/KitOverlaysSection.ts'

// The design system's shadcn/ui kit page, opened straight from references/.
// Its page chrome is what the app's design system page is built to match.
const kitUrl = new URL(
  '../../../references/deprecated/fortymm-design-system/ui_kits/shadcn/index.html',
  import.meta.url,
).href

// The app's fonts, where its self-hosted Space Grotesk stylesheet lives.
const fontsDir = new URL('../../src/assets/fonts/', import.meta.url)

export class ReferenceKitPage {
  readonly page: Page
  readonly header: Locator
  readonly title: Locator
  readonly subtitle: Locator
  readonly intro: Locator
  readonly forms: KitFormsSection
  readonly display: KitDataDisplaySection
  readonly nav: KitNavigationSection
  readonly overlays: KitOverlaysSection
  readonly feedback: KitFeedbackSection

  constructor(page: Page) {
    this.page = page
    this.header = page.getByRole('banner')
    this.title = this.header.getByRole('heading', { level: 1 })
    this.subtitle = this.header.locator('.sub')
    // The paragraph right after the header.
    this.intro = page.getByRole('paragraph').first()
    this.forms = new KitFormsSection(page)
    this.display = new KitDataDisplaySection(page)
    this.nav = new KitNavigationSection(page)
    this.overlays = new KitOverlaysSection(page)
    this.feedback = new KitFeedbackSection(page)
  }

  async goto(): Promise<void> {
    // The kit embeds its display and mono fonts but loads Space Grotesk from
    // Google Fonts. Serve it the app's own Space Grotesk stylesheet instead,
    // unchanged, so both pages load the same font files the same way, offline.
    // The stylesheet's relative URLs resolve to Google Fonts' host too, so
    // the font files come through this route as well.
    await this.page.route('https://fonts.googleapis.com/**', (route) => {
      const file = new URL(route.request().url()).pathname.slice(1)
      return route.fulfill({
        path: fileURLToPath(
          new URL(file.endsWith('.woff2') ? file : 'space-grotesk.css', fontsDir),
        ),
        // The kit is opened from disk, so its fonts are cross-origin.
        headers: { 'Access-Control-Allow-Origin': '*' },
      })
    })
    await this.page.goto(kitUrl)
  }

  // Swaps in other header copy, so the header can be compared pixel for
  // pixel with a page that says something else.
  async setHeaderText(title: string, subtitle: string): Promise<void> {
    await this.title.evaluate((el, text) => (el.textContent = text), title)
    await this.subtitle.evaluate((el, text) => (el.textContent = text), subtitle)
  }
}
