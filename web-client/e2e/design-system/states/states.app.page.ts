import { type Locator, type Page } from '@playwright/test'
import { sectionHeading } from '../locators.ts'
import { type StatesBoard } from './states.board.ts'

// The States board in the app: /design-system/states.
export class StatesAppPage implements StatesBoard {
  private readonly page: Page
  readonly stateMatrixHeading: Locator

  constructor(page: Page) {
    this.page = page
    this.stateMatrixHeading = sectionHeading(page, 'State matrix')
  }

  async goto() {
    await this.page.goto('/design-system/states')
  }
}
