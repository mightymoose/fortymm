import { type Locator, type Page } from '@playwright/test'
import { sectionHeading } from '../locators.ts'
import { gotoReference } from '../reference.ts'
import { type MoreBoard } from './more.board.ts'

// The More board in the reference: More.dc.html.
export class MoreReferencePage implements MoreBoard {
  private readonly page: Page
  readonly moreComponentsHeading: Locator

  constructor(page: Page) {
    this.page = page
    this.moreComponentsHeading = sectionHeading(page, 'More components')
  }

  async goto() {
    await gotoReference(this.page, 'More.dc.html')
  }
}
