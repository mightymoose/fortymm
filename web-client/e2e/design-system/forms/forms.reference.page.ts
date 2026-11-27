import { type Locator, type Page } from '@playwright/test'
import { sectionHeading } from '../locators.ts'
import { gotoReference } from '../reference.ts'
import { type FormsBoard } from './forms.board.ts'

// The Forms board in the reference: Forms.dc.html.
export class FormsReferencePage implements FormsBoard {
  private readonly page: Page
  readonly fieldsAndChoicesHeading: Locator
  readonly selectionHeading: Locator

  constructor(page: Page) {
    this.page = page
    this.fieldsAndChoicesHeading = sectionHeading(page, 'Fields and choices')
    this.selectionHeading = sectionHeading(page, 'Selection')
  }

  async goto() {
    await gotoReference(this.page, 'Forms.dc.html')
  }
}
