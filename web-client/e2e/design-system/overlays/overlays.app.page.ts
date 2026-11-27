import { type Locator, type Page } from '@playwright/test'
import { sectionHeading } from '../locators.ts'
import { type OverlaysBoard } from './overlays.board.ts'

// The Overlays board in the app: /design-system/overlays.
export class OverlaysAppPage implements OverlaysBoard {
  private readonly page: Page
  readonly overlaysHeading: Locator

  constructor(page: Page) {
    this.page = page
    this.overlaysHeading = sectionHeading(page, 'Overlays')
  }

  async goto() {
    await this.page.goto('/design-system/overlays')
  }
}
