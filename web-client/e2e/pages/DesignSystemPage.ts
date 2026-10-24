import type { Locator, Page } from '@playwright/test'
import { GalleryPage } from './GalleryPage.ts'

// Page object for the app's design system page in the Playwright suite. It
// shows no loading screen, so there's nothing to wait out.
export class DesignSystemPage extends GalleryPage {
  readonly loadingScreen: Locator

  constructor(page: Page) {
    super(page)
    this.loadingScreen = page.getByRole('status', { name: 'Loading FortyMM' })
  }

  protected url(query: string): string {
    return `/design-system${query}`
  }
}
