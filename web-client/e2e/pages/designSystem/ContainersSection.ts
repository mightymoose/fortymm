import type { Locator, Page } from '@playwright/test'
import { SectionObject } from './SectionObject.ts'

// The Containers section: a card, a scroll area and a split view of the
// schedule beside the picked match's details.
export class ContainersSection extends SectionObject {
  readonly card: Locator
  readonly scrollArea: Locator
  readonly splitView: Locator
  // The check-in list that scrolls inside its card.
  readonly players: Locator
  readonly schedule: Locator
  readonly splitHandle: Locator
  // The details panel beside the schedule.
  readonly matchDetails: Locator
  // The dialog that the details' "Withdraw a player…" opens.
  readonly withdrawPlayerDialog: Locator

  constructor(page: Page) {
    super(page, 'containers')
    this.card = this.example('ex-card')
    this.scrollArea = this.example('ex-scroll-area')
    this.splitView = this.example('ex-split-view')
    this.players = this.scrollArea.getByLabel('Players', { exact: true })
    this.schedule = this.splitView.getByLabel('Schedule timeline', { exact: true })
    this.splitHandle = this.splitView.getByRole('separator', {
      name: 'Resize schedule and match details',
    })
    this.matchDetails = this.splitView.locator('[aria-live="polite"]')
    this.withdrawPlayerDialog = page.getByRole('dialog', {
      name: 'Withdraw a player from this match?',
    })
  }

  // The section's button named `name`, e.g. "Check in all".
  button(name: string): Locator {
    return this.region.getByRole('button', { name, exact: true })
  }

  // The schedule block of the match `match`, named by its players in full,
  // e.g. "Patel, Meera vs Park, Ji-ho".
  block(match: string): Locator {
    return this.schedule.getByRole('button', { name: match })
  }
}
