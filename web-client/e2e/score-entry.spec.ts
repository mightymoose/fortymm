import { expect, test } from '@playwright/test'
import { ScoreEntryPage } from './page-objects/score-entry.page'

test.describe('Score entry', () => {
  test('renders the current game entry with match context', async ({ page }) => {
    const scoreEntry = await ScoreEntryPage.navigateTo(page, { gameId: '3' })

    await expect(scoreEntry.heading).toHaveText('Enter game 3 score.')
    await expect(scoreEntry.gameTag).toContainText('GAME 03 OF 05')
    await expect(scoreEntry.metaLine).toContainText(
      'RATED · BEST OF 5 · FIRST TO 3',
    )
    await expect(scoreEntry.meInput).toBeVisible()
    await expect(scoreEntry.oppInput).toBeVisible()
  })

  test('keeps the save button disabled until a valid score is entered', async ({
    page,
  }) => {
    const scoreEntry = await ScoreEntryPage.navigateTo(page, { gameId: '3' })

    await expect(scoreEntry.saveButton).toBeDisabled()

    // A drawn game is not a valid table tennis result.
    await scoreEntry.enterScores('11', '11')
    await expect(scoreEntry.saveButton).toBeDisabled()

    await scoreEntry.enterScores('11', '7')
    await expect(scoreEntry.saveButton).toBeEnabled()
  })

  test('advances to the next game when the score is saved', async ({ page }) => {
    const scoreEntry = await ScoreEntryPage.navigateTo(page, { gameId: '3' })

    await scoreEntry.enterScores('11', '7')
    await scoreEntry.saveButton.click()

    await expect(page).toHaveURL(/\/matches\/m-2207\/games\/4\/scores\/new$/)
    await expect(scoreEntry.heading).toHaveText('Enter game 4 score.')
  })

  test('shows every game in the scoreline with the current game active', async ({
    page,
  }) => {
    const scoreEntry = await ScoreEntryPage.navigateTo(page, { gameId: '3' })

    await expect(scoreEntry.scorelineCells).toHaveCount(5)
    await expect(scoreEntry.activeCell).toContainText('G3')
    // Games already played carry their stored score into the strip.
    await expect(scoreEntry.cell(1)).toContainText('11')
    await expect(scoreEntry.cell(1)).toContainText('8')
  })

  test('opens a played game from the scoreline with its score prefilled', async ({
    page,
  }) => {
    const scoreEntry = await ScoreEntryPage.navigateTo(page, { gameId: '3' })

    await scoreEntry.cell(1).click()

    await expect(page).toHaveURL(/\/matches\/m-2207\/games\/1\/scores\/new$/)
    await expect(scoreEntry.heading).toHaveText('Enter game 1 score.')
    await expect(scoreEntry.meInput).toHaveValue('11')
    await expect(scoreEntry.oppInput).toHaveValue('8')
  })
})
