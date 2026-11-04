import type { Locator, Page } from '@playwright/test'

// Page object for the page that sets up a new match, in the Playwright
// suite.
export class NewMatchPage {
  readonly page: Page
  readonly title: Locator
  readonly searchAll: Locator
  readonly searchBox: Locator
  readonly searchResults: Locator
  readonly startButton: Locator

  constructor(page: Page) {
    this.page = page
    this.title = page.getByRole('heading', { level: 1 })
    this.searchAll = page.getByRole('button', { name: 'Search all players' })
    this.searchBox = page.getByRole('searchbox', { name: 'Search players by name' })
    this.searchResults = page.getByRole('list', { name: 'Players found' })
    this.startButton = page.getByRole('button', { name: 'Start match' })
  }

  async goto(): Promise<void> {
    await this.page.goto('/matches/new')
  }

  // Searches every player for `name` and picks the one the search finds.
  async pickBySearch(name: string): Promise<void> {
    await this.searchAll.click()
    await this.searchBox.fill(name)
    await this.searchResults.getByRole('button', { name }).click()
  }
}
