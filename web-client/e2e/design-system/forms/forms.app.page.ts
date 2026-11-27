import { type Locator, type Page } from '@playwright/test'
import { sectionHeading } from '../locators.ts'
import { type FormsBoard } from './forms.board.ts'

// The Forms board in the app: /design-system/forms.
export class FormsAppPage implements FormsBoard {
  private readonly page: Page
  readonly fieldsAndChoicesHeading: Locator
  readonly selectionHeading: Locator

  constructor(page: Page) {
    this.page = page
    this.fieldsAndChoicesHeading = sectionHeading(page, 'Fields and choices')
    this.selectionHeading = sectionHeading(page, 'Selection')
  }

  async goto() {
    await this.page.goto('/design-system/forms')
  }
}
