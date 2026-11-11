import type { Locator, Page } from '@playwright/test'

// The web client's match database screen, at /match-database.
export class MatchDatabasePage {
  readonly makeParcel: Locator
  readonly apply: Locator
  readonly outcomes: Locator
  readonly newDatabase: Locator
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
    this.makeParcel = page.getByRole('button', { name: 'Make a match parcel' })
    this.apply = page.getByRole('button', { name: 'Apply the parcels' })
    this.outcomes = page.getByRole('list', { name: 'What happened to each parcel' })
    this.newDatabase = page.getByRole('textbox', { name: 'New database' })
  }

  parcel(number: number) {
    return this.page.getByRole('textbox', { name: `Parcel ${number}` })
  }

  async open() {
    await this.page.goto('/match-database')
  }
}
