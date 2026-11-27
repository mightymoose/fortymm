import { type Locator, type Page } from '@playwright/test'
import { sectionHeading } from '../locators.ts'
import { gotoReference } from '../reference.ts'
import { type RolesBoard } from './roles.board.ts'

// The Roles board in the reference: Roles.dc.html.
export class RolesReferencePage implements RolesBoard {
  private readonly page: Page
  readonly rolesAtAGlanceHeading: Locator
  readonly buttonsHeading: Locator

  constructor(page: Page) {
    this.page = page
    this.rolesAtAGlanceHeading = sectionHeading(page, 'Roles at a glance')
    this.buttonsHeading = sectionHeading(page, 'Buttons')
  }

  async goto() {
    await gotoReference(this.page, 'Roles.dc.html')
  }
}
