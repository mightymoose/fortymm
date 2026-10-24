import type { Locator, Page } from '@playwright/test'
import { KitSectionObject } from './KitSectionObject.ts'

// The reference kit's Feedback section.
export class KitFeedbackSection extends KitSectionObject {
  readonly alertCard: Locator
  readonly toastCard: Locator

  constructor(page: Page) {
    super(page, 'feedback')
    this.alertCard = this.card('Alert')
    this.toastCard = this.card('Sonner / Toast')
  }
}
