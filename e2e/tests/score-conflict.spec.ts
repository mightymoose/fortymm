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
 * End-to-end coverage for the 409 score-conflict flow (issue #873).
 *
 * This path is structurally unreachable on a *solo* match: producing a version
 * conflict requires a second participant committing the same game while the
 * first is still editing. Every prior browser QA pass over scoring used a solo
 * match, so the conflict notice + "Replace with my score" have never been
 * exercised end-to-end. This spec provisions a real two-party match over the
 * API and drives the loser's side through the browser.
 *
 * The ordering is load-bearing. A's page must load the score at version 1
 * *before* B commits version 2 — otherwise A mounts already holding the fresh
 * version and its save never conflicts. The score-detail query has no polling
 * and no window-focus refetch fires in a single focused page, so once A has
 * loaded v1 it holds that stale version until it submits (proven deterministic
 * across repeated local runs against the real stack).
 */
test.describe('Score entry — 409 conflict flow', () => {
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

    // A starts a best-of-3 (so game 1 is not the decider — saving it continues
    // to game 2 rather than firing the finalize flow, keeping this focused on
    // the conflict surface) match against B, and commits game 1 at version 1.
    const opponentId = await findUserId(a, b.username)
    const matchId = await createMatch(a, opponentId, 3)
    const v1 = await createGameScore(a, matchId, 1, 11, 5)
    expect(v1).toBe(1)

    // A opens game 1's edit screen and loads the committed score at v1 — its
    // own 11 must be showing before B writes, or there is no stale version to
    // conflict on.
    const scorePage = await ScoreEntryPage.navigateToEdit(page, matchId, 1)
    await expect(scorePage.scoreInput(a.username)).toHaveValue('11')
    await expect(scorePage.scoreInput(b.username)).toHaveValue('5')

    // B now commits a different score (B wins 5–11), bumping the game to v2.
    const bEdit = await editGameScore(b, matchId, 1, 5, 11, v1)
    expect(bEdit.status()).toBe(200)

    // A, still holding v1, edits to 11–9 and saves. The per-game save is
    // fire-and-forget: it advances to the next game synchronously while the PUT
    // settles in the background, where the conditional write loses the version
    // race → 409. That surfaces as the conflict-review banner on game 2, which
    // routes back to game 1 rather than showing the notice inline.
    await scorePage.scoreInput(b.username).fill('9')
    await scorePage.saveButton.click()

    await expect(scorePage.conflictReviewBanner(1)).toBeVisible()
    await scorePage.reviewGameButton(1).click()

    // Back on game 1's edit screen, the in-page conflict notice renders B's
    // committed score (B's win as A sees it, A on side 1 → "A 5 – 11 B") against
    // A's rejected entry — proving the notice shows the *server's* value, not
    // A's stale one.
    await expect(scorePage.conflictNotice).toBeVisible()
    await expect(scorePage.conflictNotice).toContainText(`${a.username} 5`)
    await expect(scorePage.conflictNotice).toContainText('Your entry was 11')

    // "Replace with my score" re-fires the save against the now-fresh v2. It
    // must succeed on the first try — a 200, not a second 409 — which is the
    // half the unit tests never covered.
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
