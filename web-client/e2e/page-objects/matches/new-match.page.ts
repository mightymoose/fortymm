import type { Locator, Page } from '@playwright/test'
import { MatchStore, type MatchStoreSeed } from './match-store'

/** Best-of value → the segmented control's label, used to target each radio. */
const BEST_OF_LABEL: Record<number, string> = {
  1: 'Single',
  3: 'Short',
  5: 'Std',
  7: 'Long',
}

/**
 * Page object for `/matches/new`. `open()` installs a `MatchStore` mock,
 * navigates, and waits for the card to render; everything else is a thin
 * locator or a small action wrapper.
 */
export class NewMatchPage {
  readonly heading: Locator
  readonly youName: Locator
  readonly startButton: Locator
  /**
   * What the same submit control calls itself while the user is mid-search with
   * nothing committed (#893). Its own locator, not a variant of `startButton`:
   * "Start solo match" deliberately does NOT match `/start match/i`, so a spec
   * asserting `startButton` is absent is asserting the honest relabel happened.
   */
  readonly soloStartButton: Locator
  readonly cancelButton: Locator
  readonly error: Locator
  readonly ratedSwitch: Locator
  readonly selectedOpponentName: Locator
  readonly summaryTop: Locator
  readonly summarySub: Locator
  readonly emptyPlayers: Locator
  /** Placeholder grid shown while recent opponents load. */
  readonly recentSkeleton: Locator
  /** Inline fallback when a players request fails. */
  readonly pickerError: Locator
  /** "Try again" button inside the picker error fallback. */
  readonly pickerRetry: Locator
  /** Hint shown in the typeahead before anything is typed. */
  readonly searchHint: Locator
  /** "No one matches …" message in the typeahead dropdown. */
  readonly searchNoMatch: Locator
  readonly searchAllButton: Locator
  /** The visible exit from search mode, back to the recent grid (#895). */
  readonly backToRecentButton: Locator

  static async open(
    page: Page,
    seed: MatchStoreSeed = {},
  ): Promise<NewMatchPage> {
    const store = new MatchStore(seed)
    await store.install(page)
    await page.goto('/matches/new')
    const pom = new NewMatchPage(page, store)
    await pom.heading.waitFor()
    return pom
  }

  constructor(
    public readonly page: Page,
    public readonly store: MatchStore,
  ) {
    this.heading = page.getByRole('heading', { level: 1, name: /new match/i })
    this.youName = page.locator('.nm-you-strip .name')
    this.startButton = page.getByRole('button', { name: /start match/i })
    this.soloStartButton = page.getByRole('button', {
      name: /start solo match/i,
    })
    this.cancelButton = page.getByRole('button', { name: /^cancel$/i })
    this.error = page.locator('.nm-error')
    this.ratedSwitch = page.getByRole('switch', { name: /rated match/i })
    this.selectedOpponentName = page.locator('.nm-selected .name')
    this.summaryTop = page.locator('.nm-summary .top')
    this.summarySub = page.locator('.nm-summary .sub')
    this.emptyPlayers = page.getByText(/no opponents yet/i)
    this.recentSkeleton = page.getByRole('status', { name: /loading players/i })
    this.pickerError = page.locator('.nm-picker-error')
    this.pickerRetry = page.getByRole('button', { name: /try again/i })
    this.searchHint = page.getByText(/start typing to search/i)
    this.searchNoMatch = page.getByText(/no one matches/i)
    this.searchAllButton = page.getByRole('button', {
      name: /search all players/i,
    })
    this.backToRecentButton = page.getByRole('button', {
      name: /back to recent opponents/i,
    })
  }

  /** A registered-player chip in the default picker grid. */
  playerChip(username: string): Locator {
    return this.page.locator('.nm-chip', { hasText: username })
  }

  /** A row in the typeahead search dropdown. */
  searchResult(username: string): Locator {
    return this.page.locator('.nm-item', { hasText: username })
  }

  async pickPlayer(username: string): Promise<void> {
    await this.playerChip(username).click()
  }

  async changeOpponent(): Promise<void> {
    await this.page.getByRole('button', { name: /^change$/i }).click()
  }

  async openSearch(): Promise<void> {
    await this.searchAllButton.click()
  }

  async backToRecent(): Promise<void> {
    await this.backToRecentButton.click()
  }

  async search(term: string): Promise<void> {
    await this.page.getByPlaceholder(/search by username/i).fill(term)
  }

  bestOfOption(games: number): Locator {
    return this.page.getByRole('radio', { name: BEST_OF_LABEL[games] })
  }

  async setBestOf(games: number): Promise<void> {
    await this.bestOfOption(games).click()
  }

  async toggleRated(): Promise<void> {
    await this.ratedSwitch.click()
  }

  async start(): Promise<void> {
    await this.startButton.click()
  }
}
