import { fileURLToPath } from 'node:url'
import { GalleryPage } from './GalleryPage.ts'

// The design system's component gallery, opened straight from references/.
// The app's design system page is built to match it.
const galleryUrl = new URL(
  '../../../references/design-system/ui_kits/components/index.html',
  import.meta.url,
).href

// The app's fonts, where its self-hosted Space Grotesk stylesheet lives.
const fontsDir = new URL('../../src/assets/fonts/', import.meta.url)

export class ReferenceKitPage extends GalleryPage {
  private fontsRouted = false

  override async goto(only?: string): Promise<void> {
    if (!this.fontsRouted) {
      // The gallery embeds its display and mono fonts but loads Space
      // Grotesk from Google Fonts. Serve it the app's own Space Grotesk
      // stylesheet instead, unchanged, so both pages load the same font
      // files the same way, offline. The stylesheet's relative URLs resolve
      // to Google Fonts' host too, so the font files come through this
      // route as well.
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
      this.fontsRouted = true
    }
    await super.goto(only)
  }

  protected url(query: string): string {
    return `${galleryUrl}${query}`
  }

  // Swaps in other title text, so the title can be compared pixel for pixel
  // with a page that says something else.
  async setTitleText(title: string): Promise<void> {
    await this.title.evaluate((el, text) => (el.textContent = text), title)
  }
}
