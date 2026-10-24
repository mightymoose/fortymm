import type { Locator, Page } from '@playwright/test'
import { SectionObject } from './SectionObject.ts'

// The Roles at a glance section. It has no examples: each role has its own
// test id, which the gallery's TESTING.md lists.
export class RolesSection extends SectionObject {
  readonly card: Locator
  readonly noticeExamples: Locator
  readonly toast: Locator
  readonly tooltip: Locator
  readonly warning: Locator
  readonly error: Locator

  constructor(page: Page) {
    super(page, 'roles')
    this.card = this.example('role-card')
    this.noticeExamples = this.example('role-notice-examples')
    this.toast = this.example('role-toast')
    this.tooltip = this.example('role-tooltip')
    this.warning = this.example('role-warning')
    this.error = this.example('role-error')
  }

  // The section's button named `name`, e.g. "Retry now".
  button(name: string): Locator {
    return this.region.getByRole('button', { name, exact: true })
  }
}
