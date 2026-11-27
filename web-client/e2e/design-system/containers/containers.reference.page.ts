import { type Locator, type Page } from '@playwright/test'
import {
  exampleHeaded,
  exampleItem,
  exampleNamed,
  exampleParagraph,
  exampleStatus,
  findAreaAround,
  type Margins,
  type NamedRole,
  sectionHeading,
} from '../locators.ts'
import { gotoReference } from '../reference.ts'
import { type ContainersBoard, type ContainersExample } from './containers.board.ts'

// The Containers board in the reference: Containers.dc.html.
export class ContainersReferencePage implements ContainersBoard {
  private readonly page: Page
  readonly containersHeading: Locator
  readonly feedbackHeading: Locator
  readonly containersPage: Locator

  constructor(page: Page) {
    this.page = page
    this.containersHeading = sectionHeading(page, 'Containers')
    this.feedbackHeading = sectionHeading(page, 'Feedback')
    this.containersPage = page.getByTestId('page-containers')
  }

  example(testId: ContainersExample) {
    return this.page.getByTestId(testId)
  }

  named(example: ContainersExample, role: NamedRole, name: string) {
    return exampleNamed(this.page, example, role, name)
  }

  findToastArea(message: string, margins: Margins) {
    return findAreaAround(this.page, exampleStatus(this.page, 'ex-toast', message), margins)
  }

  notice(text: string) {
    return exampleParagraph(this.page, 'ex-inline-notice', text)
  }

  alert(title: string) {
    return exampleItem(this.page, 'ex-warning-and-error', title)
  }

  status(heading: string) {
    return exampleHeaded(this.page, 'ex-status-set', 4, heading)
  }

  async goto() {
    await gotoReference(this.page, 'Containers.dc.html')
  }
}
