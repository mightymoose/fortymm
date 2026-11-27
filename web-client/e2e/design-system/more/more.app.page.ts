import { type Locator, type Page } from '@playwright/test'
import { sectionHeading } from '../locators.ts'
import { type MoreBoard } from './more.board.ts'

// The More board in the app: /design-system/more.
export class MoreAppPage implements MoreBoard {
  private readonly page: Page
  readonly moreComponentsHeading: Locator

  constructor(page: Page) {
    this.page = page
    this.moreComponentsHeading = sectionHeading(page, 'More components')
  }

  async goto() {
    await this.page.goto('/design-system/more')
  }
}
