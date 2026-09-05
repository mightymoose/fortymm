import { test, expect } from '@playwright/test'

import { ScoreEntryPage } from '../page-objects/score-entry.page'
import {
  createGameScore,
  createGameScoreRaw,
  createMatch,
  deleteGameScore,
  findUserId,
  guestFromContext,
  mintGuest,
} from '../support/match-api'

/**
 * Every screen numbers a match's games the same way (#1661, item 5).
 *
 * The QA pass cleared game 1 of a best-of-3 that already held game 2, and saved
 * game 4 of a best-of-5 before games 2 and 3. Each left a **gap** in the board, and
 * every surface then told its own story about it: the entry page showed G1 empty and
 * G2 saved, the opponent's match page showed that same score under G1 with "Live ·
 * Game 1", and finalizing renumbered the games contiguously.
 *
 * A gap is not a state a table-tennis match can be in — games are played in order —
 * so the bar is that the board can never hold one: a game is saved only after every
 * earlier game is, and only the **last** saved game can be cleared. The refusal names
 * the game to deal with first, and the entry screen says the same thing before the
 * player types.
 */
test.describe('Score entry — the board stays contiguous', () => {
  test('saving after reconnect replays failed earlier games first', async ({
    page,
    baseURL,
  }) => {
    const a = await guestFromContext(page.request)
    const b = await mintGuest(baseURL!)
    const matchId = await createMatch(a, await findUserId(a, b.username), 5)
    const entry = await ScoreEntryPage.navigateToNew(page, matchId, 1)
    await entry.scoreInput(a.username).fill('11')
    await entry.scoreInput(b.username).fill('5')
    const failed = page.waitForEvent('requestfailed', {
      predicate: (request) =>
        request.method() === 'POST' &&
        request.url().endsWith('/games/1/scores/new'),
    })
    await page.context().setOffline(true)
    await entry.saveNextButton.click()
    await failed
    await page.context().setOffline(false)
    await expect(entry.heading).toHaveText('Enter game 2 score.')
    await expect(entry.failedGameLink(1)).toBeVisible()
    await entry.scoreInput(a.username).fill('5')
    await entry.scoreInput(b.username).fill('11')
    await entry.saveNextButton.click()
    await expect(entry.heading).toHaveText('Enter game 3 score.')
    await expect(entry.savedGameLink(1)).toBeVisible({ timeout: 15_000 })
    await expect(entry.savedGameLink(2)).toBeVisible()
    await b.ctx.dispose()
  })

  test('a game cannot be saved past an unsaved one, nor cleared from under a later one', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    const a = await guestFromContext(page.request)
    const b = await mintGuest(baseURL!)
    // A best-of-5 — long enough to skip a game in the middle of.
    const matchId = await createMatch(a, await findUserId(a, b.username), 5)

    await createGameScore(a, matchId, 1, 11, 5)

    // Saving game 3 with game 2 still unsaved leaves a gap: refused, naming game 2.
    const skipAhead = await createGameScoreRaw(a, matchId, 3, 11, 7)
    expect(skipAhead.status(), await skipAhead.text()).toBe(422)
    expect(((await skipAhead.json()) as { detail: string }).detail).toMatch(
      /Save game 2 before game 3/,
    )

    // In order, it saves.
    await createGameScore(a, matchId, 2, 11, 7)

    // Clearing game 1 from under a saved game 2 would leave a gap: refused, naming
    // game 2 and the alternative (edit game 1 instead).
    const clearUnder = await deleteGameScore(a, matchId, 1)
    expect(clearUnder.status(), await clearUnder.text()).toBe(422)
    expect(((await clearUnder.json()) as { detail: string }).detail).toMatch(
      /Clear game 2 first/,
    )

    // The last game clears, and then the one before it does.
    expect((await deleteGameScore(a, matchId, 2)).status()).toBe(200)
    expect((await deleteGameScore(a, matchId, 1)).status()).toBe(200)

    // ----- the entry screen says so before the player types ------------------------
    // With only game 1 saved, the game-3 entry screen is a refusal naming game 2,
    // not a form the save would 422 on.
    await createGameScore(a, matchId, 1, 11, 5)
    const entry = await ScoreEntryPage.navigateToNew(page, matchId, 3)
    await expect(entry.refusal).toBeVisible()
    await expect(entry.refusal).toContainText(/Save game 2 before game 3/)
    await expect(entry.scoreInput(a.username)).toBeHidden()

    await b.ctx.dispose()
  })
})
