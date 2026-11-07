import { readFileSync } from 'node:fs'
import { GalleryPage } from './GalleryPage.ts'

// The design system's component gallery, opened straight from references/.
// The app's design system page is built to match it.
const galleryUrl = new URL(
  '../../../references/design-system/ui_kits/components/index.html',
  import.meta.url,
).href

// The app's Space Grotesk stylesheet with its font files inlined as data:
// URLs, so the gallery has the font from its first layout, with no fetch to
// race (see loadTestModeFonts() in src/testMode.ts).
const fontsDir = new URL('../../src/assets/fonts/', import.meta.url)
const spaceGroteskCss = readFileSync(new URL('space-grotesk.css', fontsDir), 'utf8').replace(
  /url\('\.\/([^']+\.woff2)'\)/g,
  (_, file: string) =>
    `url('data:font/woff2;base64,${readFileSync(new URL(file, fontsDir)).toString('base64')}')`,
)

export class ReferenceKitPage extends GalleryPage {
  private fontsRouted = false

  override async goto(only?: string): Promise<void> {
    if (!this.fontsRouted) {
      // The gallery embeds its display and mono fonts but loads Space
      // Grotesk from Google Fonts. Serve it the app's own Space Grotesk
      // stylesheet instead, with the same font files, so both pages show
      // the same font, offline.
      await this.page.route('https://fonts.googleapis.com/**', (route) =>
        route.fulfill({ body: spaceGroteskCss, contentType: 'text/css' }),
      )
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
