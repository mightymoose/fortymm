import { test, expect } from '@playwright/test'
import { faker } from '@faker-js/faker'

import { ScoreEntryPage } from '../page-objects/score-entry.page'
import { TournamentDetailPage } from '../page-objects/tournament-detail.page'
import { findUserId, guestFromContext, mintGuest } from '../support/match-api'
import { grantBetaTester } from '../support/rbac-grant'
import {
  callFixture,
  enterPlayer,
  firstFixture,
  seedTournament,
} from '../support/tournament-api'

const EVENT_NAME = 'Open Singles'

/**
 * End-to-end coverage for the round-robin tournament lifecycle (the C1/C2
 * orchestration), against the REAL composed stack — no stubs.
 *
 * A director creates a tournament with one singles, round-robin, **unrated**,
 * best-of-1 event drawn across a single group → publishes → enters two players →
 * cuts the draw → goes live (materializing the one fixture into a *scheduled*,
 * born-`pending` match — "Not started", #1073) → CALLS it onto the seeded table
 * with a full manual placement (which flips it `pending → in_progress` and makes
 * it scorable) → records the result → the standings crown the winner champion at
 * rank #1.
 *
 * ## Why unrated is load-bearing
 *
 * An unrated tournament match takes the **immediate self-accept** completion path:
 * proposing the result COMPLETES it with no second party accepting. So one browser
 * session (the director, who is also a participant) drives the whole thing — there
 * is no opponent tab to run.
 *
 * ## Seed vs UI split
 *
 * The inert scaffolding — the tournament, its event, its reservation, and the second
 * entrant (director-entry, which has no web UI) — is provisioned over the API
 * (`support/tournament-api.ts`). The load-bearing lifecycle steps are driven
 * through the browser: publishing, the director's own Enter, cutting the draw,
 * going live, recording the result, and reading the standings. The one exception
 * is the **call** — flipping the scheduled fixture live via a full placement — run
 * over the API (`callFixture`), since a placement drag has no simple UI surface to
 * script here; the spec verifies its *effect* (the "In progress" status) in the
 * browser.
 *
 * ## RBAC
 *
 * A minted user holds only the default `User` role, which carries no permissions.
 * `grantBetaTester` hands the director the `tournament.view`/`create`/`enter`
 * bundle over the stack's own `postgres` container before any tournament write —
 * without it every one of them 403s. On an external `E2E_BASE_URL` stack the grant
 * is skipped (the caller must arrange it), and the API seed's 403 is the honest
 * signal if they did not.
 */
test.describe('Tournament — round-robin lifecycle', () => {
  test('a 2-player unrated round-robin goes live, is played, and crowns its champion', async ({
    page,
    baseURL,
  }) => {
    // Five full page loads off a Vite **dev** server (each paying for its route's
    // on-demand transform), a second minted guest, a real draw cut, a go-live that
    // materializes the fixture and enqueues a CP-SAT solve on the stack's own worker, and
    // a scored match — measured at just over a minute here, against a 30s default this
    // spec never declared. Every other tournament spec in this suite already carries an
    // explicit budget for the same reason; this one predates them.
    //
    // It is a **budget, not a wait**: nothing below sleeps, and every assertion is
    // web-first, so a genuine regression still reds on its own locator rather than
    // burning the whole 3 minutes.
    test.setTimeout(180_000)
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    // The director IS the browser's own session (`page.request` shares the page
    // context's cookie jar), so page navigations run authenticated as them.
    const director = await guestFromContext(page.request)
    // Grant the tournament permissions the flow needs; a no-op against a stack
    // this suite does not own (E2E_BASE_URL), where the caller provisions it.
    grantBetaTester(director.username)

    // The inert scaffolding, over the API, as the director (so it comes back
    // `can_edit: true` and the browser sees the owner controls).
    const name = `RR ${faker.string.alphanumeric(8)}`
    const { tournamentId, eventId, groupId, tables } = await seedTournament(
      director,
      name,
    )

    // The second entrant — a wholly separate guest, searchable as an opponent.
    const opponent = await mintGuest(baseURL!)
    const opponentId = await findUserId(director, opponent.username)

    const detail = await TournamentDetailPage.navigateTo(page, tournamentId)

    // ----- publish: draft → published (opens registration) ------------------
    // Click plus confirm: the header's edge only asks the question, and the transition
    // is what the dialog's own button fires.
    await detail.publishTournament()
    await expect(detail.startButton).toBeVisible()

    // ----- enter the director themselves, through the UI --------------------
    await detail.enterButton(EVENT_NAME).click()
    // The control flips to Withdraw once the entry lands — the entry took.
    await expect(detail.withdrawButton(EVENT_NAME)).toBeVisible()
    await expect(detail.entrantsList(EVENT_NAME)).toContainText(director.username)

    // ----- enter the second player by director-entry (no web UI) ------------
    await enterPlayer(director, tournamentId, eventId, opponentId)
    await detail.reload(tournamentId)
    await expect(detail.entrantsList(EVENT_NAME)).toContainText(director.username)
    await expect(detail.entrantsList(EVENT_NAME)).toContainText(opponent.username)

    // ----- cut the draw: 2 entrants in 1 group = exactly 1 fixture -----------
    await detail.generateDrawButton(EVENT_NAME).click()
    // The one fixture pairs the two entrants. It is not yet a match — no link.
    await expect(detail.drawPanel(eventId)).toContainText(director.username)
    await expect(detail.drawPanel(eventId)).toContainText(opponent.username)
    await expect(detail.viewMatchLink(eventId)).toBeHidden()

    // ----- go live: published → live (materializes the fixture) -------------
    await detail.startTournament()
    // Now live: the only edge left is End. But the fixture is materialized as a
    // *scheduled* match, not a live one (#1073): it is born `pending`, so it reads
    // "Not started" and is NOT yet scorable. The materialized fixture already
    // carries its deep-link (the match exists) — the link shows for a pending
    // fixture; only the status word differs from a called one.
    await expect(detail.endButton).toBeVisible()
    await expect(detail.fixtureMatchStatus(eventId)).toHaveText('Not started')
    await expect(detail.viewMatchLink(eventId)).toBeVisible()

    // ----- call the fixture: a full manual placement flips it live ----------
    // The director calls the pending fixture onto the tournament's seeded table
    // (a full placement PATCH is a call while live), which flips its match
    // `pending → in_progress` and makes it scorable (#1073). We need the fixture
    // id, not just the match id, to address its placement.
    const fixture = await firstFixture(director, tournamentId, eventId)
    await callFixture(director, tournamentId, fixture.id, tables[0].id)
    await detail.reload(tournamentId)
    // Now the fixture reads live, and its deep-link is still there to follow.
    await expect(detail.fixtureMatchStatus(eventId)).toHaveText('In progress')
    await expect(detail.viewMatchLink(eventId)).toBeVisible()

    // ----- record the result, through the score-entry UI --------------------
    // The called match's id — deep-link the browser into its score entry the way
    // score-conflict.spec.ts does (learn the URL over the API, drive the surface).
    const { match_id: matchId } = fixture
    // Narrow off null (a materialized fixture always carries one) — both the
    // assertion and the type guard the deep-link below needs.
    if (matchId === null) {
      throw new Error('the materialized fixture carries no match id')
    }
    const score = await ScoreEntryPage.navigateToNew(page, matchId, 1)
    // The director wins 11–5, so they are the sole group winner → champion. Inputs
    // are labelled by username, so this is correct whichever side each was drawn on.
    await score.scoreInput(director.username).fill('11')
    await score.scoreInput(opponent.username).fill('5')
    // On an unrated match "Finalize result" proposes AND self-accepts in one POST,
    // completing the match with no opponent tab. Wait for that 201 to settle.
    const resultsPost = page.waitForResponse(
      (r) =>
        r.url().includes(`/matches/${matchId}/results`) &&
        r.request().method() === 'POST',
    )
    await score.finalizeButton.click()
    expect((await resultsPost).status()).toBe(201)

    // ----- the standings crown the champion ---------------------------------
    const played = await TournamentDetailPage.navigateTo(page, tournamentId)
    // The champion callout renders ONLY for the rank-#1 leader of a complete,
    // single-group round-robin, so its presence with the director's name is the
    // "winner ranked #1 as champion" fact itself.
    await expect(played.standingsChampion(eventId)).toBeVisible()
    await expect(played.standingsChampion(eventId)).toContainText(director.username)
    // And the group table shows both entrants, with the director in the top row.
    // `groupId` is nullable on the seed — a reservation-less seed (`reservations: []`,
    // which mints no groups) has no first group — but this seed took the default single
    // reservation, so it is a string here.
    expect(groupId, 'the default seed reserves one group').not.toBeNull()
    const standings = played.groupStandings(groupId!)
    await expect(standings).toContainText(director.username)
    await expect(standings).toContainText(opponent.username)
    // Row 0 is the header; row 1 is rank 1 — the director, the champion.
    await expect(standings.getByRole('row').nth(1)).toContainText(director.username)

    await opponent.ctx.dispose()
  })
})
