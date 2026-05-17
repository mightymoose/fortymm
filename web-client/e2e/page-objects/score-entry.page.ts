import { Locator, Page } from '@playwright/test'

type NavigateOptions = {
  matchId?: string
  gameId?: string
  // When provided, navigates to the edit route instead of the create route.
  scoreId?: string
  // Pin the opponent username so the input aria-label resolves. The default
  // tracks the seed for `m-2207`.
  opponentUsername?: string
}

// Stable identifiers from `buildInitialSeeds()` in src/mocks/match-store.ts.
// Hard-coded here so the e2e doesn't have to reach into the mock module.
export const SEED = {
  matchId: 'm-2207',
  game3Id: 'g-2207-3',
  game1Id: 'g-2207-1',
  score1Id: 's-2207-1',
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
      gameId = SEED.game3Id,
      scoreId,
      opponentUsername = SEED.opponentUsername,
    }: NavigateOptions = {},
  ): Promise<ScoreEntryPage> {
    const url = scoreId
      ? `/matches/${matchId}/games/${gameId}/scores/${scoreId}/edit`
      : `/matches/${matchId}/games/${gameId}/scores/new`
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
