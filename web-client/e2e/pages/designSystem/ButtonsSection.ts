import type { Locator, Page } from '@playwright/test'
import { SectionObject } from './SectionObject.ts'

// The design system page's Buttons section.
export class ButtonsSection extends SectionObject {
  readonly variants: Locator
  readonly loadingAndDisabled: Locator

  constructor(page: Page) {
    super(page, 'Buttons')
    this.variants = this.example('Variants')
    this.loadingAndDisabled = this.example('Loading and disabled')
  }

  // The section's button named `name`, e.g. "Call to table".
  button(name: string): Locator {
    return this.region.getByRole('button', { name, exact: true })
  }
}
