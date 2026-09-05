import { test, expect } from '@playwright/test'
import { faker } from '@faker-js/faker'

import { NotificationsPage } from '../page-objects/notifications.page'
import {
  completeUnratedMatch,
  createMatch,
  findUserId,
  guestFromContext,
  mintGuest,
} from '../support/match-api'
import { listNotifications, noticesTitled } from '../support/notifications-api'
import { grantBetaTester } from '../support/rbac-grant'
import {
  callFixture,
  cutDraw,
  enterPlayer,
  firstFixture,
  seedTournament,
  transitionTournament,
} from '../support/tournament-api'

const RECORDED = 'Your match result was recorded'

/** How long to wait for the notice. Unlike a call (persisted in the pin
 * transaction), this notice is delivered by the stack's ONE RQ worker, which also
 * runs every other spec's schedule solves — under the full suite it queues behind
 * them, so the budget is the same one the solver spec gives a worker round-trip. */
const NOTICE_TIMEOUT_MS = 120_000

/**
 * A player is told when someone else records their result (#1661, item 4; #1585,
 * #1650).
 *
 * A tournament director may score and finalize a match they do not play in
 * (#1523), and on an unrated match a director's result — or an opponent's — is final
 * the moment it is posted: there is no acceptance round-trip. The QA pass found the
 * players heard nothing either way, so a player could find their match over, and
 * their record changed, without ever seeing a message.
 *
 * The bar: whenever a result is finalized on a match **without a player's
 * acceptance**, every player who did not post it is told — in their feed, naming who
 * recorded it and the score, linking to the match. The poster is not told (they
 * did it). Two shapes of the same rule: the director's result on a tournament match,
 * and an opponent's result on a casual unrated match.
 */
test.describe('Match result — a result recorded by someone else is announced', () => {
  test('both players are told when the tournament director finalizes their match', async ({
    page,
    browser,
    baseURL,
  }) => {
    test.setTimeout(180_000)
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    const director = await guestFromContext(page.request)
    grantBetaTester(director.username)

    // The director is NOT a player: two minted guests are the entrants.
    const name = `Recorded ${faker.string.alphanumeric(8)}`
    const { tournamentId, eventId, tables } = await seedTournament(director, name)
    const a = await mintGuest(baseURL!)
    const b = await mintGuest(baseURL!)
    await transitionTournament(director, tournamentId, 'published')
    for (const guest of [a, b]) {
      await enterPlayer(
        director,
        tournamentId,
        eventId,
        await findUserId(director, guest.username),
      )
    }
    await cutDraw(director, tournamentId, eventId)
    await transitionTournament(director, tournamentId, 'live')

    const fixture = await firstFixture(director, tournamentId, eventId)
    expect(fixture.match_id, 'the fixture materialized at go-live').not.toBeNull()
    const matchId = fixture.match_id!
    await callFixture(director, tournamentId, fixture.id, tables[0].id)

    // The director records the whole best-of-1 result from the scorers' table.
    await completeUnratedMatch(director, matchId, [
      { game_number: 1, side_1_points: 11, side_2_points: 5 },
    ])

    // Both players are told: who recorded it, the score, and where to look.
    for (const player of [a, b]) {
      await expect
        .poll(
          async () => noticesTitled(await listNotifications(player), RECORDED).length,
          { timeout: NOTICE_TIMEOUT_MS, intervals: [2_000] },
        )
        .toBe(1)
      const [notice] = noticesTitled(await listNotifications(player), RECORDED)
      expect(notice.body).toContain(director.username)
      expect(notice.body).toMatch(/tournament director/)
      expect(notice.body).toContain('11–5')
      expect(notice.link).toBe(`/matches/${matchId}`)
    }
    // The director, who did the recording, is not told about their own act.
    expect(noticesTitled(await listNotifications(director), RECORDED)).toHaveLength(0)

    // And it reaches the player's own screen: open the feed as A.
    const aContext = await browser.newContext({
      baseURL: baseURL!,
      storageState: await a.ctx.storageState(),
    })
    const feed = await NotificationsPage.navigateTo(await aContext.newPage())
    await expect(feed.resultRecordedNotice).toBeVisible({ timeout: 30_000 })
    await aContext.close()

    await a.ctx.dispose()
    await b.ctx.dispose()
  })

  test('the opponent is told when a casual unrated result is finalized without them', async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(180_000)
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()
    const a = await guestFromContext(page.request)
    const b = await mintGuest(baseURL!)

    // "Just for fun" — no rating, so A's post is final at once (#1650).
    const matchId = await createMatch(a, await findUserId(a, b.username), 1)
    await completeUnratedMatch(a, matchId, [
      { game_number: 1, side_1_points: 11, side_2_points: 0 },
    ])

    await expect
      .poll(async () => noticesTitled(await listNotifications(b), RECORDED).length, {
        timeout: NOTICE_TIMEOUT_MS,
        intervals: [2_000],
      })
      .toBe(1)
    const [notice] = noticesTitled(await listNotifications(b), RECORDED)
    expect(notice.body).toContain(a.username)
    expect(notice.body).toContain('11–0')
    expect(notice.link).toBe(`/matches/${matchId}`)
    // The poster is not told about their own post.
    expect(noticesTitled(await listNotifications(a), RECORDED)).toHaveLength(0)

    await b.ctx.dispose()
  })
})
