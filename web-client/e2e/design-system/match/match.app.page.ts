import { type Locator, type Page } from '@playwright/test'
import { sectionHeading } from '../locators.ts'
import { type MatchBoard } from './match.board.ts'

// The Match board in the app: /design-system/match.
export class MatchAppPage implements MatchBoard {
  private readonly page: Page
  readonly matchComponentsHeading: Locator

  constructor(page: Page) {
    this.page = page
    this.matchComponentsHeading = sectionHeading(page, 'Match components')
  }

  async goto() {
    await this.page.goto('/design-system/match')
  }
}
