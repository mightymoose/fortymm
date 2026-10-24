import type { Locator, Page } from '@playwright/test'
import { SectionObject } from './SectionObject.ts'

// The Feedback section.
export class FeedbackSection extends SectionObject {
  readonly toast: Locator
  readonly inlineNotice: Locator
  readonly warningAndError: Locator
  readonly statusSet: Locator

  constructor(page: Page) {
    super(page, 'feedback')
    this.toast = this.example('ex-toast')
    this.inlineNotice = this.example('ex-inline-notice')
    this.warningAndError = this.example('ex-warning-and-error')
    this.statusSet = this.example('ex-status-set')
  }

  // The section's button named `name`, e.g. "Mark Table 4 free".
  button(name: string): Locator {
    return this.region.getByRole('button', { name, exact: true })
  }
}
