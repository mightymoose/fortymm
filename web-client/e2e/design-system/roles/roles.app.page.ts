import { type Locator, type Page } from '@playwright/test'
import { sectionHeading } from '../locators.ts'
import { type RolesBoard } from './roles.board.ts'

// The Roles board in the app: /design-system/roles.
export class RolesAppPage implements RolesBoard {
  private readonly page: Page
  readonly rolesAtAGlanceHeading: Locator
  readonly buttonsHeading: Locator

  constructor(page: Page) {
    this.page = page
    this.rolesAtAGlanceHeading = sectionHeading(page, 'Roles at a glance')
    this.buttonsHeading = sectionHeading(page, 'Buttons')
  }

  async goto() {
    await this.page.goto('/design-system/roles')
  }
}
