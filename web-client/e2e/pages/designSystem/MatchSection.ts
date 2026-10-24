import type { Locator, Page } from '@playwright/test'
import { SectionObject } from './SectionObject.ts'

// The Match components section: match rows, an empty table and an offline
// scorer, score entry with its game history, schedule blocks and the rest
// indicator.
export class MatchSection extends SectionObject {
  readonly matchRow: Locator
  readonly emptyAndDisconnected: Locator
  readonly scoreEntry: Locator
  readonly scheduleBlocks: Locator
  readonly restIndicator: Locator
  // The game history under the score entry.
  readonly history: Locator

  constructor(page: Page) {
    super(page, 'match')
    this.matchRow = this.example('ex-match-row')
    this.emptyAndDisconnected = this.example('ex-empty-and-disconnected')
    this.scoreEntry = this.example('ex-score-entry-and-game-history')
    this.scheduleBlocks = this.example('ex-schedule-blocks')
    this.restIndicator = this.example('ex-rest-indicator')
    this.history = this.scoreEntry.getByRole('table', {
      name: 'Game scores, Patel, Meera vs Wójcik-Szymańska, Agnieszka',
    })
  }

  // The section's button named `name`, e.g. "+1 Patel".
  button(name: string): Locator {
    return this.region.getByRole('button', { name, exact: true })
  }

  // The match row of the match `match`, named by its players in full, e.g.
  // "Nguyen, Thanh vs Silva, Rafael".
  row(match: string): Locator {
    return this.region.getByRole('article', { name: match, exact: true })
  }

  // The schedule block of the match `match`, named by its players in full.
  block(match: string): Locator {
    return this.scheduleBlocks.getByRole('button', { name: match })
  }

  // The score entry's points for the player `surname`, e.g. "Patel".
  points(surname: string): Locator {
    return this.scoreEntry.getByLabel(`${surname} points`, { exact: true })
  }

  // Scores a point for each player in `surnames`, in order, with the "+1"
  // targets.
  async score(...surnames: string[]): Promise<void> {
    for (const surname of surnames) await this.button(`+1 ${surname}`).click()
  }
}
