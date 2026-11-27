import { type Locator, type Page } from '@playwright/test'
import { exampleControl, findAreaAround, type Margins, sectionHeading } from '../locators.ts'
import { type RolesBoard, type RolesExample, type RolesRole } from './roles.board.ts'

// The Roles board in the app: /design-system/roles.
export class RolesAppPage implements RolesBoard {
  private readonly page: Page
  readonly rolesAtAGlanceHeading: Locator
  readonly buttonsHeading: Locator
  readonly toast: Locator
  readonly tooltip: Locator
  readonly rolesPage: Locator

  constructor(page: Page) {
    this.page = page
    this.rolesAtAGlanceHeading = sectionHeading(page, 'Roles at a glance')
    this.buttonsHeading = sectionHeading(page, 'Buttons')
    const roles = page.getByTestId('section-roles')
    this.toast = roles.getByRole('status')
    this.tooltip = roles.getByText(
      'Johansen-Whitfield, Annika vs Rossi, Giulia · 11:05–11:40',
      { exact: true },
    )
    this.rolesPage = page.getByTestId('page-roles')
  }

  example(testId: RolesExample) {
    return this.page.getByTestId(testId)
  }

  button(example: RolesExample, name: string) {
    return exampleControl(this.page, example, 'button', name)
  }

  link(example: RolesExample, name: string) {
    return exampleControl(this.page, example, 'link', name)
  }

  role(testId: RolesRole) {
    return this.page.getByTestId(testId)
  }

  findToastArea(margins: Margins) {
    return findAreaAround(this.page, this.toast, margins)
  }

  findTooltipArea(margins: Margins) {
    return findAreaAround(this.page, this.tooltip, margins)
  }

  async goto() {
    await this.page.goto('/design-system/roles')
  }
}
