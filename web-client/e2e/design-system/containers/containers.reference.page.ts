import { type Locator, type Page } from '@playwright/test'
import { sectionHeading } from '../locators.ts'
import { gotoReference } from '../reference.ts'
import { type ContainersBoard } from './containers.board.ts'

// The Containers board in the reference: Containers.dc.html.
export class ContainersReferencePage implements ContainersBoard {
  private readonly page: Page
  readonly containersHeading: Locator
  readonly feedbackHeading: Locator

  constructor(page: Page) {
    this.page = page
    this.containersHeading = sectionHeading(page, 'Containers')
    this.feedbackHeading = sectionHeading(page, 'Feedback')
  }

  async goto() {
    await gotoReference(this.page, 'Containers.dc.html')
  }
}
