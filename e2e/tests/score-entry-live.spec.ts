import { test, expect } from '@playwright/test'

import { ScoreEntryPage } from '../page-objects/score-entry.page'
import {
  completeUnratedMatch,
  createGameScore,
  createMatch,
  editGameScore,
  findUserId,
  guestFromContext,
  mintGuest,
} from '../support/match-api'

/**
 * An open score-entry page shows what the other side did (#1661, item 6; #1651).
 *
 * The QA pass had both players on the same match: one player's "Replace with my
 * score" did not appear on the other's open entry page until that player's next
 * save, and a page left open after the opponent finalized still offered
 * "Finalize result" and then printed an error with no way forward.
 *
 * The bar, in three states of the viewer's page:
 *
 * - **clean** (nothing typed): the opponent's save fills the inputs, unasked;
 * - **dirty** (a score typed): the opponent's save surfaces as the same conflict
 *   notice a rejected save would, so the viewer decides — nothing is silently
 *   overwritten in either direction;
 * - **over** (the opponent finalized): the page says the match is closed instead of
 *   offering to finalize it again.
 *
 * Each arrives through the same pushed hint the dashboard is kept fresh by; the
 * page never needs a reload or a save of its own to notice.
 */
test.describe('Score entry — the page follows the other side', () => {
  test('keeping a saved score replaces both fields on a dirty edit page', async ({ page, baseURL }) => {
    const a = await guestFromContext(page.request)
    const b = await mintGuest(baseURL!)
    const matchId = await createMatch(a, await findUserId(a, b.username), 3)
    const version = await createGameScore(a, matchId, 1, 11, 5)
    const entry = await ScoreEntryPage.navigateToEdit(page, matchId, 1)
    await expect(entry.scoreInput(a.username)).toHaveValue('11')
    await entry.scoreInput(b.username).fill('7')
    const edited = await editGameScore(b, matchId, 1, 5, 11, version)
    expect(edited.status()).toBe(200)
    await expect(entry.conflictNotice).toBeVisible({ timeout: 15_000 })
    await entry.keepSavedButton.click()
    await expect(entry.conflictNotice).toBeHidden()
    await expect(entry.scoreInput(a.username)).toHaveValue('5')
    await expect(entry.scoreInput(b.username)).toHaveValue('11')
    await b.ctx.dispose()
  })

  test('a clean page fills in the opponent\'s save, then closes when they finalize', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()
    const a = await guestFromContext(page.request)
    const b = await mintGuest(baseURL!)
    const matchId = await createMatch(a, await findUserId(a, b.username), 3)

    // A opens game 1 with nothing saved and types nothing.
    const entry = await ScoreEntryPage.navigateToNew(page, matchId, 1)
    await expect(entry.heading).toHaveText('Enter game 1 score.')
    await expect(entry.scoreInput(a.username)).toHaveValue('')

    // B saves game 1 from their own session: A 11 – B 5.
    await createGameScore(b, matchId, 1, 11, 5)

    // A's untouched inputs take the saved score — no reload, no save of A's own.
    await expect(entry.scoreInput(a.username)).toHaveValue('11', { timeout: 15_000 })
    await expect(entry.scoreInput(b.username)).toHaveValue('5')

    // B finalizes the match (game 2 decides a best-of-3, unrated → final at once).
    await completeUnratedMatch(b, matchId, [
      { game_number: 1, side_1_points: 11, side_2_points: 5 },
      { game_number: 2, side_1_points: 11, side_2_points: 3 },
    ])

    // A's page says the match is closed — and stops offering to score it.
    await expect(entry.refusal).toBeVisible({ timeout: 15_000 })
    await expect(entry.refusal).toContainText(
      /posted result|no longer scorable|no longer open/,
    )
    await expect(entry.scoreInput(a.username)).toBeHidden()
    await expect(entry.finalizeButton).toBeHidden()

    await b.ctx.dispose()
  })

  test('a dirty page surfaces the opponent\'s save as a conflict to resolve, without a save of its own', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()
    const a = await guestFromContext(page.request)
    const b = await mintGuest(baseURL!)
    const matchId = await createMatch(a, await findUserId(a, b.username), 3)

    // A opens game 1 and types a score — the page is now dirty with A's view.
    const entry = await ScoreEntryPage.navigateToNew(page, matchId, 1)
    await entry.scoreInput(a.username).fill('11')
    await entry.scoreInput(b.username).fill('9')

    // B saves the same game the other way round.
    await createGameScore(b, matchId, 1, 5, 11)

    // A's page shows B's committed score against A's own entry — the same notice a
    // rejected save raises — with no click from A. A's typing is not overwritten,
    // and B's save is not clobbered by a stale version.
    await expect(entry.conflictNotice).toBeVisible({ timeout: 15_000 })
    await expect(entry.conflictNotice).toContainText(`${a.username} 5`)
    await expect(entry.conflictNotice).toContainText('Your entry was 11')

    // A keeps the saved score: the inputs adopt it and the notice clears.
    await entry.keepSavedButton.click()
    await expect(entry.conflictNotice).toBeHidden()
    await expect(entry.scoreInput(a.username)).toHaveValue('5')
    await expect(entry.scoreInput(b.username)).toHaveValue('11')

    await b.ctx.dispose()
  })
})
