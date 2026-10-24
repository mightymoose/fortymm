import type { Locator, Page } from '@playwright/test'
import { SectionObject } from './SectionObject.ts'

// The design system page's Feedback section.
export class FeedbackSection extends SectionObject {
  readonly alertCard: Locator
  readonly toastCard: Locator

  constructor(page: Page) {
    super(page, 'Feedback')
    this.alertCard = this.region.getByRole('article', {
      name: 'Alert',
      exact: true,
    })
    this.toastCard = this.region.getByRole('article', {
      name: 'Sonner / Toast',
      exact: true,
    })
  }

  // The alert card's alert titled `name`, e.g. "Heads up".
  alert(name: string): Locator {
    return this.alertCard.getByRole('alert', { name, exact: true })
  }

  // The toast card's toast titled `name`, e.g. "Reminder".
  toast(name: string): Locator {
    return this.toastCard.getByRole('status', { name, exact: true })
  }

  // The close button of the toast titled `title`.
  toastDismissButton(title: string): Locator {
    return this.toastCard.getByRole('button', {
      name: `Dismiss "${title}"`,
      exact: true,
    })
  }

  // The toast card's action button named `name`, e.g. "Reload".
  toastActionButton(name: string): Locator {
    return this.toastCard.getByRole('button', { name, exact: true })
  }
}
