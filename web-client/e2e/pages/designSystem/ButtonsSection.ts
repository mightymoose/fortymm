import type { Locator, Page } from '@playwright/test'
import { SectionObject } from './SectionObject.ts'

// The Buttons section.
export class ButtonsSection extends SectionObject {
  readonly variants: Locator
  readonly loadingAndDisabled: Locator

  constructor(page: Page) {
    super(page, 'actions')
    this.variants = this.example('ex-variants')
    this.loadingAndDisabled = this.example('ex-loading-and-disabled')
  }

  // The section's button named `name`, e.g. "Call to table".
  button(name: string): Locator {
    return this.region.getByRole('button', { name, exact: true })
  }
}
