import { type Locator, type Page } from '@playwright/test'
import { sectionHeading } from '../locators.ts'
import { gotoReference } from '../reference.ts'
import { type OverlaysBoard } from './overlays.board.ts'

// The Overlays board in the reference: Overlays.dc.html.
export class OverlaysReferencePage implements OverlaysBoard {
  private readonly page: Page
  readonly overlaysHeading: Locator

  constructor(page: Page) {
    this.page = page
    this.overlaysHeading = sectionHeading(page, 'Overlays')
  }

  async goto() {
    await gotoReference(this.page, 'Overlays.dc.html')
  }
}
