import { type Locator, type Page } from '@playwright/test'
import { sectionHeading } from '../locators.ts'
import { type ContainersBoard } from './containers.board.ts'

// The Containers board in the app: /design-system/containers.
export class ContainersAppPage implements ContainersBoard {
  private readonly page: Page
  readonly containersHeading: Locator
  readonly feedbackHeading: Locator

  constructor(page: Page) {
    this.page = page
    this.containersHeading = sectionHeading(page, 'Containers')
    this.feedbackHeading = sectionHeading(page, 'Feedback')
  }

  async goto() {
    await this.page.goto('/design-system/containers')
  }
}
