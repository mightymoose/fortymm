import type { Locator, Page } from '@playwright/test'
import { KitSectionObject } from './KitSectionObject.ts'

// The reference gallery's Buttons section.
export class KitButtonsSection extends KitSectionObject {
  readonly variants: Locator
  readonly loadingAndDisabled: Locator

  constructor(page: Page) {
    super(page, 'actions')
    this.variants = this.example('variants')
    this.loadingAndDisabled = this.example('loading-and-disabled')
  }

  // The section's button named `name`, e.g. "Call to table".
  button(name: string): Locator {
    return this.region.getByRole('button', { name, exact: true })
  }
}
