import { type Locator, type Page } from '@playwright/test'
import { sectionHeading, sectionLink } from '../locators.ts'
import { type MainBoard } from './main.board.ts'

// The Main board in the app: /design-system.
export class MainAppPage implements MainBoard {
  private readonly page: Page
  readonly heading: Locator
  readonly foundationsHeading: Locator
  readonly foundationsLink: Locator
  readonly rolesLink: Locator
  readonly formsLink: Locator
  readonly containersLink: Locator
  readonly overlaysLink: Locator
  readonly matchLink: Locator
  readonly moreLink: Locator
  readonly statesLink: Locator

  constructor(page: Page) {
    this.page = page
    this.heading = page.getByRole('heading', { level: 1, name: 'FortyMM component showcase' })
    this.foundationsHeading = sectionHeading(page, 'Foundations')
    this.foundationsLink = sectionLink(page, 'Foundations')
    this.rolesLink = sectionLink(page, 'Roles and buttons')
    this.formsLink = sectionLink(page, 'Fields and selection')
    this.containersLink = sectionLink(page, 'Containers and feedback')
    this.overlaysLink = sectionLink(page, 'Overlays')
    this.matchLink = sectionLink(page, 'Match components')
    this.moreLink = sectionLink(page, 'More components')
    this.statesLink = sectionLink(page, 'State matrix')
  }

  async goto() {
    await this.page.goto('/design-system')
  }
}
