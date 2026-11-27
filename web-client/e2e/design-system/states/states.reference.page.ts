import { type Locator, type Page } from '@playwright/test'
import { sectionHeading } from '../locators.ts'
import { gotoReference } from '../reference.ts'
import { type StatesBoard } from './states.board.ts'

// The States board in the reference: States.dc.html.
export class StatesReferencePage implements StatesBoard {
  private readonly page: Page
  readonly stateMatrixHeading: Locator

  constructor(page: Page) {
    this.page = page
    this.stateMatrixHeading = sectionHeading(page, 'State matrix')
  }

  async goto() {
    await gotoReference(this.page, 'States.dc.html')
  }
}
