import { type Locator, type Page } from '@playwright/test'
import { sectionHeading } from '../locators.ts'
import { gotoReference } from '../reference.ts'
import { type MatchBoard } from './match.board.ts'

// The Match board in the reference: Match.dc.html.
export class MatchReferencePage implements MatchBoard {
  private readonly page: Page
  readonly matchComponentsHeading: Locator

  constructor(page: Page) {
    this.page = page
    this.matchComponentsHeading = sectionHeading(page, 'Match components')
  }

  async goto() {
    await gotoReference(this.page, 'Match.dc.html')
  }
}
