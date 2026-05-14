import { Locator, Page } from '@playwright/test'

type NavigateOptions = {
  matchId?: string
  gameId?: string
}

export class ScoreEntryPage {
  public readonly page: Page
  public readonly heading: Locator
  public readonly gameTag: Locator
  public readonly metaLine: Locator
  public readonly meInput: Locator
  public readonly oppInput: Locator
  public readonly saveButton: Locator
  public readonly scorelineCells: Locator
  public readonly activeCell: Locator

  static async navigateTo(
    page: Page,
    { matchId = 'm-2207', gameId = '3' }: NavigateOptions = {},
  ): Promise<ScoreEntryPage> {
    await page.goto(`/matches/${matchId}/games/${gameId}/scores/new`)
    return new ScoreEntryPage(page)
  }

  constructor(page: Page) {
    this.page = page
    this.heading = page.getByRole('heading', { level: 2 })
    this.gameTag = page.locator('.live-bar .tag')
    this.metaLine = page.locator('.live-bar .meta')
    this.meInput = page.getByRole('textbox', { name: 'You score' })
    this.oppInput = page.getByRole('textbox', { name: 'Nguyen, T. score' })
    this.saveButton = page.getByRole('button', { name: /save .*game/i })
    this.scorelineCells = page.locator('.sl-cell')
    this.activeCell = page.locator('.sl-cell[aria-current="step"]')
  }

  cell(gameNumber: number): Locator {
    return this.scorelineCells.nth(gameNumber - 1)
  }

  async enterScores(me: string, opp: string): Promise<void> {
    await this.meInput.fill(me)
    await this.oppInput.fill(opp)
  }
}
