import { test, expect } from '@playwright/test'

import { ScoreEntryPage } from '../page-objects/score-entry.page'
import {
  createGameScore,
  createMatch,
  editGameScore,
  findUserId,
  guestFromContext,
  mintGuest,
} from '../support/match-api'

/**
 * End-to-end coverage for the score-conflict flow (issue #873, reshaped by #1661).
 *
 * This path is structurally unreachable on a *solo* match: producing a version
 * conflict requires a second participant committing the same game while the
 * first is still editing. This spec provisions a real two-party match over the
 * API and drives the loser's side through the browser.
 *
 * Since #1661 the entry page follows the other side live: the moment B's edit
 * lands, A's page — which holds A's own typed entry — surfaces the conflict notice
 * on its own, before A ever presses Save. The conditional-write 409 behind the
 * notice is still the server's guarantee for the race a hint can't outrun; what
 * this spec proves is the flow a player actually meets: the notice shows the
 * *server's* value against their own, and "Replace with my score" then succeeds
 * first try against the fresh version.
 */
test.describe('Score entry — conflict flow', () => {
  test('the loser sees the committed score and "Replace with my score" then succeeds first try', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    // Guest A is the browser's own session (`page.request` shares the page
    // context's cookie jar), so page navigations run authenticated as A.
    const a = await guestFromContext(page.request)

    // Guest B is a wholly separate session (its own cookie jar) — the concurrent
    // participant who writes the same game out from under A.
    const b = await mintGuest(baseURL!)

    // A starts a best-of-3 match against B, and commits game 1 at version 1.
    const opponentId = await findUserId(a, b.username)
    const matchId = await createMatch(a, opponentId, 3)
    const v1 = await createGameScore(a, matchId, 1, 11, 5)
    expect(v1).toBe(1)

    // A opens game 1's edit screen, loads the committed score at v1, and edits it
    // to 11–9 — a dirty page holding A's own view.
    const scorePage = await ScoreEntryPage.navigateToEdit(page, matchId, 1)
    await expect(scorePage.scoreInput(a.username)).toHaveValue('11')
    await expect(scorePage.scoreInput(b.username)).toHaveValue('5')
    await scorePage.scoreInput(b.username).fill('9')

    // B now commits a different score (B wins 5–11), bumping the game to v2.
    const bEdit = await editGameScore(b, matchId, 1, 5, 11, v1)
    expect(bEdit.status()).toBe(200)

    // A's page notices on its own: the in-page conflict notice renders B's
    // committed score (B's win as A sees it, A on side 1 → "A 5 – 11 B") against
    // A's typed entry — proving the notice shows the *server's* value, not A's
    // stale one, and that A's typing survived the refetch.
    await expect(scorePage.conflictNotice).toBeVisible({ timeout: 15_000 })
    await expect(scorePage.conflictNotice).toContainText(`${a.username} 5`)
    await expect(scorePage.conflictNotice).toContainText('Your entry was 11')

    // "Replace with my score" fires the save against the now-fresh v2. It must
    // succeed on the first try — a 200, not a 409.
    const replacePut = page.waitForResponse(
      (r) =>
        r.url().includes(`/matches/${matchId}/games/1/scores`) &&
        r.request().method() === 'PUT',
    )
    await scorePage.replaceButton.click()
    expect((await replacePut).status()).toBe(200)

    // The conflict is resolved: the notice clears and A's score now stands.
    await expect(scorePage.conflictNotice).toBeHidden()
    await expect(scorePage.scoreInput(a.username)).toHaveValue('11')
    await expect(scorePage.scoreInput(b.username)).toHaveValue('9')

    await b.ctx.dispose()
  })
})
