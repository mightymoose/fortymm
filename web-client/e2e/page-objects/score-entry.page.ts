import { Locator, Page } from '@playwright/test'

type NavigateOptions = {
  matchId?: string
  gameNumber?: number
  // When true, navigates to the edit route instead of the create route.
  edit?: boolean
  // Pin the opponent username so the input aria-label resolves. The default
  // tracks the seed for `m-2207`.
  opponentUsername?: string
}

// Stable identifiers mirroring `m-2207` from src/mocks/match-store.ts (1-1
// mid-match). Hard-coded here so the e2e doesn't have to reach into the mock
// module. The match id is a real UUID, not the `m-2207` placeholder, because
// the scoring routes guard the param shape and short-circuit to the friendly
// not-found page for anything that isn't UUID-shaped (#385) — production match
// ids are UUIDs (`gen_random_uuid()`), so the e2e seed must be too or the page
// never renders.
export const SEED = {
  matchId: '22070000-0000-4000-8000-000000000000',
  // After the decouple-scoring refactor games 1 + 2 are scratchpad scores;
  // game 3 is the next un-scored slot. All addressing is by game number.
  nextGameNumber: 3,
  scoredGameNumber: 1,
  opponentUsername: 'nguyen.t',
  meUsername: 'rita.kovac',
} as const

export class ScoreEntryPage {
  public readonly page: Page
  public readonly heading: Locator
  public readonly meInput: Locator
  public readonly oppInput: Locator
  public readonly saveButton: Locator
  public readonly scorelineCells: Locator
  public readonly activeCell: Locator
  public readonly inlineError: Locator

  static async navigateTo(
    page: Page,
    {
      matchId = SEED.matchId,
      gameNumber = SEED.nextGameNumber,
      edit = false,
      opponentUsername = SEED.opponentUsername,
    }: NavigateOptions = {},
  ): Promise<ScoreEntryPage> {
    const url = edit
      ? `/matches/${matchId}/games/${gameNumber}/scores/edit`
      : `/matches/${matchId}/games/${gameNumber}/scores/new`
    await page.goto(url)
    return new ScoreEntryPage(page, opponentUsername)
  }

  constructor(page: Page, opponentUsername: string = SEED.opponentUsername) {
    this.page = page
    this.heading = page.getByRole('heading', { level: 2 })
    this.meInput = page.getByRole('textbox', { name: `${SEED.meUsername} score` })
    this.oppInput = page.getByRole('textbox', {
      name: `${opponentUsername} score`,
    })
    this.saveButton = page.getByRole('button', { name: /save/i })
    this.scorelineCells = page.locator('.sl-cell')
    this.activeCell = page.locator('.sl-cell[aria-current="step"]')
    this.inlineError = page.getByRole('alert')
  }

  cell(gameNumber: number): Locator {
    return this.scorelineCells.nth(gameNumber - 1)
  }

  async enterScores(me: string, opp: string): Promise<void> {
    await this.meInput.fill(me)
    await this.oppInput.fill(opp)
  }
}
