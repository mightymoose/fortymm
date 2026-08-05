import { test, expect, type Page } from '@playwright/test'
import { faker } from '@faker-js/faker'

import { TournamentDetailPage } from '../page-objects/tournament-detail.page'
import { guestFromContext, type Guest } from '../support/match-api'
import { grantBetaTester } from '../support/rbac-grant'
import {
  createTournament,
  findEventByName,
  getDrawTypeCatalogue,
  seedEntrants,
} from '../support/tournament-api'

/** The event the director authors in the browser, and the handle the spec finds it by
 * afterwards — its id is minted server-side and never crosses back through the UI. */
const EVENT_NAME = 'Open Singles'

/** The draw type's **server-authored** label. The picker renders the served catalogue
 * (ADR 20260726), so this string is the `draw_types` seed row's `name` column, not the
 * client's — which is why choosing by it is itself the "a real name, not a raw slug"
 * assertion. */
const DRAW_TYPE_LABEL = 'Swiss'
/** The slug the same row is keyed by, and the value the event stores as its `draw_type`.
 * Named separately from the label precisely so the two can be compared. */
const DRAW_TYPE_KEY = 'swiss'

/** **R** — the round count, a **required** setting with no derived default (ADR "swiss
 * pre-cuts every round and pairs each one on advance"). Three, because the demoable
 * outcome is "round 1 paired, the later rounds present but not yet paired" and one later
 * round could be a coincidence of an off-by-one. It also stays under the cut's
 * `R <= n - 1` refusal for both fields below. */
const ROUNDS = 3

/** `n` for the two parities, which are two different code paths and not two sizes of the
 * same one. Eight pairs the whole field every round; seven leaves exactly one entrant
 * with **no fixture at all**, because a bye is the absence of a row (ADR-0786) — and that
 * is the case whose fixtures seat one fewer entrant than the event has, which is what
 * used to read as a stale draw and refuse go-live. */
const EVEN_FIELD = 8
const ODD_FIELD = 7

/**
 * Round one, as the ADR seeds it: **top half against bottom half in draw order**.
 *
 * With `m = 2⌊n/2⌋` entrants actually playing, draw-order position `i` meets position
 * `i + m/2`, so `⌊n/2⌋` fixtures come out in position order. The draw order is
 * registration order here: `order_entrants` sorts by seed, then `created_at`, and nothing
 * seeds these entries — while `seedEntrants` enters its guests **sequentially**, on
 * purpose, exactly so this is derivable rather than a race.
 *
 * An odd field's last-registered entrant is therefore the lowest-ranked, and is the one
 * this function never names: they are the round's **bye**.
 *
 * Written as the arithmetic rather than a hand-listed table, so the expectation cannot
 * drift from the rule it is supposed to be checking.
 */
function roundOneLines(entrants: ReadonlyArray<Guest>): string[] {
  const half = Math.floor(entrants.length / 2)
  return Array.from(
    { length: half },
    (_, i) => `${entrants[i].username} vs ${entrants[i + half].username}`,
  )
}

/**
 * Author a `swiss` event **through the editor sheet** and return its id.
 *
 * Through the sheet, not seeded over the API, for the reason `tournament-rr-then-ko`
 * drives its own create: the body is `drawSettingsToApi`'s, and `rounds` is **required
 * with no default** on the swiss arm of the server's draw-settings union. A client that
 * names the format and sends no round count is a 422 at the request boundary, and nothing
 * that stubs the network can see it — the disagreement is *between* the two halves.
 *
 * Asserts the POST's status directly so that refusal names itself here, rather than
 * surfacing three steps later as a missing event.
 */
async function authorSwissEvent(
  page: Page,
  detail: TournamentDetailPage,
  director: Guest,
  tournamentId: string,
): Promise<string> {
  const editor = await detail.openNewEvent()
  await editor.nameInput.fill(EVENT_NAME)
  await editor.chooseDrawType(DRAW_TYPE_LABEL)
  // The round-count box exists ONLY for this draw type — it is absent, not disabled, for
  // a format that does not ask the question. So its appearance is the proof the picker's
  // choice reached the form, before anything is submitted.
  await expect(editor.roundsInput).toBeVisible()
  await editor.setRounds(ROUNDS)

  const createPost = page.waitForResponse(
    (r) => r.url().endsWith('/events') && r.request().method() === 'POST',
  )
  await editor.createEventButton.click()
  const createResponse = await createPost
  expect(
    createResponse.status(),
    `create event was refused: ${await createResponse.text()}`,
  ).toBe(201)
  // The sheet closes on success alone and keeps its refusal inline, so an empty error
  // slot is the second, independent word on the same fact.
  await expect(editor.errorAlert).toBeHidden()

  // A 201 says the body was accepted; only the read-back says R survived it. A server
  // that dropped the round count on the floor would answer 201 too — and then cut one
  // round, or none.
  const event = await findEventByName(director, tournamentId, EVENT_NAME)
  expect(event.draw_type).toBe(DRAW_TYPE_KEY)
  expect(event.rounds).toBe(ROUNDS)
  return event.id
}

/**
 * **Swiss, through the composed stack** (#1276, ADR "swiss pre-cuts every round and pairs
 * each one on advance").
 *
 * A director creates a swiss event **in the browser**, sets its round count, publishes,
 * has a field entered, cuts the draw, and reads it: round 1 paired with real players, and
 * every later round present, cut, and announced as forthcoming.
 *
 * ## Both parities, because they are different code
 *
 * A swiss round emits `⌊n/2⌋` fixtures whatever the parity, so an **even** field is
 * wholly seated by its own draw and an **odd** one leaves exactly one entrant referenced
 * by no fixture at all — a bye is the *absence of a row* (ADR-0786), never a row with a
 * NULL side, which here would be indistinguishable from a later round awaiting its
 * pairing.
 *
 * That difference is not cosmetic. Draw currency ("the fixtures seat exactly the active
 * entrants") compared the two sets for equality, so a seven-player swiss cut from exactly
 * those seven read **stale** the moment it was cut, and go-live refused it with a 409 no
 * re-cut could clear. Hence the odd test does not stop at the cut: it takes the
 * tournament **live**, which is the assertion that would have failed.
 *
 * ## What this spec deliberately does NOT test
 *
 * Round 2 is never paired here, because nothing pairs it yet: `SwissStrategy.advance`
 * fills no sides — it reports round 1's readiness and nothing else. Pairing a round from
 * the standings, a bye scoring as a win, and Buchholz are later slices. A spec asserting
 * round 2 gets paired would be testing an implementation that does not exist, and would
 * either red for the wrong reason or be written weak enough to pass.
 *
 * ## Seed vs UI split
 *
 * Inert scaffolding over the API (`support/tournament-api.ts`): the tournament shell and
 * the entrants — director-entry has no web UI, and fifteen browser sign-ins to test a
 * *draw* would be fifteen chances to fail for an unrelated reason. Load-bearing steps in
 * the browser: authoring the event and its round count, publishing, cutting the draw,
 * going live, and every reading of the draw.
 *
 * ## RBAC
 *
 * As in `tournament-lifecycle.spec.ts`: a minted user holds only the permissionless
 * default role, so `grantBetaTester` hands the director the tournament bundle over the
 * stack's own `postgres` container before any tournament write. Skipped against an
 * external `E2E_BASE_URL` stack, where the caller owns provisioning.
 */
test.describe('Tournament — swiss draw', () => {
  test('a director cuts an even swiss field into a paired round 1 and forthcoming later rounds', async ({
    page,
    baseURL,
  }) => {
    // Eight minted guests, eight director-entries and a real cut, on top of the ordinary
    // page work.
    test.setTimeout(300_000)
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    // The director IS the browser's own session, so page navigations run as them.
    const director = await guestFromContext(page.request)
    grantBetaTester(director.username)

    const name = `Swiss ${faker.string.alphanumeric(8)}`
    const { tournamentId } = await createTournament(director, name)

    const detail = await TournamentDetailPage.navigateTo(page, tournamentId)
    // `toContainText`, not `toHaveText`: the hero sets its own full stop after the name.
    //
    // The long timeout is for the FIRST navigation only, and it is about the stack rather
    // than the app: the composed web-client is a Vite **dev** server, so the very first
    // request for a route pays for transforming it on demand.
    await expect(detail.title).toContainText(name, { timeout: 60_000 })

    // ----- the format is OFFERED, with the server's own copy ------------------
    // Read first, before anything is authored: a stack serving a build without swiss
    // fails here, by name, rather than three steps later as an empty picker.
    //
    // `name` and `description` are **seed data** — a `draw_types` row a migration inserts
    // — so this asks the server what it is serving. The sentence itself is not retyped:
    // pinning that copy in a spec as well as in the migration is how a wording change
    // reds a suite in a file nobody thought to look at. What is asserted is that both are
    // real, director-facing strings and neither is the raw slug.
    const catalogue = await getDrawTypeCatalogue(director, tournamentId)
    const swiss = catalogue.find((row) => row.key === DRAW_TYPE_KEY)
    if (!swiss) {
      const keys = catalogue.map((row) => row.key).join(', ') || '(none)'
      throw new Error(
        `the served draw-type catalogue does not offer swiss — has: ${keys}`,
      )
    }
    expect(swiss.name).toBe(DRAW_TYPE_LABEL)
    expect(swiss.name).not.toBe(DRAW_TYPE_KEY)
    expect(swiss.description.length).toBeGreaterThan(0)
    expect(swiss.description).not.toBe(DRAW_TYPE_KEY)

    // ----- author the swiss event, in the browser -----------------------------
    // `chooseDrawType` picks the option by that same server-authored label, EXACTLY — so
    // a picker rendering `swiss` (or nothing) finds no option and reds here. It is the
    // browser's half of the assertion above.
    const eventId = await authorSwissEvent(page, detail, director, tournamentId)

    // ----- publish, then fill the field --------------------------------------
    await detail.publishButton.click()
    await expect(detail.startButton).toBeVisible()

    const entrants = await seedEntrants(
      director,
      baseURL!,
      tournamentId,
      eventId,
      EVEN_FIELD,
    )
    // How many entries landed is asked of the SERVER, not counted off the roster: the
    // card lists eight chips and collapses the rest into "+N more", so a list-item count
    // here would be counting the truncation rather than the field.
    const filled = await findEventByName(director, tournamentId, EVENT_NAME)
    expect(filled.entered).toBe(EVEN_FIELD)

    await detail.reload(tournamentId)
    await expect(detail.entrantsList(EVENT_NAME)).toContainText(entrants[0].username)

    // ----- cut the draw: all R rounds, in one stroke --------------------------
    const drawPost = page.waitForResponse(
      (r) => r.url().endsWith('/draw') && r.request().method() === 'POST',
    )
    await detail.generateDrawButton(EVENT_NAME).click()
    const drawResponse = await drawPost
    expect(
      drawResponse.status(),
      `cutting the draw was refused: ${await drawResponse.text()}`,
    ).toBe(201)

    // ----- the rounds view, NOT the bracket ----------------------------------
    // Both facts, because either alone passes against the view it is not about. Swiss and
    // an `rr-then-ko` knockout stage share `pool_id IS NULL`, and routing on that null
    // alone rendered a swiss draw through single-elimination's successor arithmetic —
    // columns named back from a Final that a format eliminating nobody does not have.
    await expect(detail.swissRounds(eventId)).toBeVisible()
    await expect(detail.bracket(eventId)).toHaveCount(0)
    // A swiss draw is pool-less: the whole field is ranked in one table.
    await expect(detail.poolDraws(eventId)).toHaveCount(0)

    // ----- round 1 is PAIRED, with real players ------------------------------
    // One statement pinning the count, the order and the pairings: `⌊8/2⌋` = four
    // fixtures, in position order, top half against bottom half of the draw order.
    await expect(detail.swissRoundFixtures(eventId, 1)).toHaveText(
      roundOneLines(entrants),
    )
    // An even field seats everybody, so nobody sits out — the half that makes the odd
    // test's single absence mean something.
    for (const entrant of entrants) {
      await expect(
        detail.swissRounds(eventId),
        `${entrant.username} entered an even field and is in no round-1 fixture`,
      ).toContainText(entrant.username)
    }

    // ----- …and rounds 2..R are CUT but not paired ---------------------------
    // The ADR's whole shape: `R × ⌊n/2⌋` fixtures written at the cut, every side of the
    // later rounds NULL. So each later round is a *forthcoming* announcement carrying its
    // own match count — not a paired list, and not absent.
    for (let round = 2; round <= ROUNDS; round += 1) {
      await expect(detail.swissRound(eventId, round)).toHaveCount(0)
      await expect(detail.swissRoundForthcoming(eventId, round)).toBeVisible()
      // `⌊n/2⌋` per round, whatever the round. The client's sentence around it is not
      // retyped — only the number the ADR fixes.
      await expect(detail.swissRoundForthcoming(eventId, round)).toContainText(
        `${EVEN_FIELD / 2} matches`,
      )
    }
    // R rounds and no more: the round count is the director's setting, never derived from
    // the field. A fourth round would mean the server had sized the draw off something
    // else.
    await expect(detail.swissRound(eventId, ROUNDS + 1)).toHaveCount(0)
    await expect(detail.swissRoundForthcoming(eventId, ROUNDS + 1)).toHaveCount(0)

    await Promise.all(entrants.map((entrant) => entrant.ctx.dispose()))
  })

  test('a director cuts an odd swiss field, one entrant sits out round 1, and the tournament goes live', async ({
    page,
    baseURL,
  }) => {
    // Seven minted guests, seven director-entries, a real cut and a real go-live (which
    // materializes round 1 into matches and enqueues the schedule solve on the stack's
    // own worker), on top of the ordinary page work.
    test.setTimeout(300_000)
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    const director = await guestFromContext(page.request)
    grantBetaTester(director.username)

    const name = `Swiss odd ${faker.string.alphanumeric(8)}`
    const { tournamentId } = await createTournament(director, name)

    const detail = await TournamentDetailPage.navigateTo(page, tournamentId)
    await expect(detail.title).toContainText(name, { timeout: 60_000 })

    const eventId = await authorSwissEvent(page, detail, director, tournamentId)

    await detail.publishButton.click()
    await expect(detail.startButton).toBeVisible()

    const entrants = await seedEntrants(
      director,
      baseURL!,
      tournamentId,
      eventId,
      ODD_FIELD,
    )
    const filled = await findEventByName(director, tournamentId, EVENT_NAME)
    // Seven, off the server. The bye assertion below is "seven entered and six are
    // named", so this number is half of it and cannot be counted off a roster that
    // truncates.
    expect(filled.entered).toBe(ODD_FIELD)

    await detail.reload(tournamentId)

    // ----- cut the draw ------------------------------------------------------
    const drawPost = page.waitForResponse(
      (r) => r.url().endsWith('/draw') && r.request().method() === 'POST',
    )
    await detail.generateDrawButton(EVENT_NAME).click()
    const drawResponse = await drawPost
    expect(
      drawResponse.status(),
      `cutting the draw was refused: ${await drawResponse.text()}`,
    ).toBe(201)

    await expect(detail.swissRounds(eventId)).toBeVisible()
    await expect(detail.bracket(eventId)).toHaveCount(0)

    // ----- exactly one entrant sits out round 1 ------------------------------
    // `⌊7/2⌋` = three fixtures naming six of the seven, in position order.
    await expect(detail.swissRoundFixtures(eventId, 1)).toHaveText(
      roundOneLines(entrants),
    )
    // …and the seventh is nowhere in the draw at all. That absence IS the bye: the format
    // byes the lowest-ranked entrant, who under registration draw order is the last one
    // in, and a bye is the absence of a fixture rather than a row with an empty side.
    const byed = entrants[entrants.length - 1]
    await expect(
      detail.swissRounds(eventId),
      `${byed.username} should be round 1's bye — a bye is the absence of a fixture`,
    ).not.toContainText(byed.username)

    // Rounds 2..R are cut and forthcoming here too, at `⌊7/2⌋` matches apiece — the byed
    // entrant costs the round a fixture, they do not get one of their own.
    for (let round = 2; round <= ROUNDS; round += 1) {
      await expect(detail.swissRound(eventId, round)).toHaveCount(0)
      await expect(detail.swissRoundForthcoming(eventId, round)).toContainText(
        `${Math.floor(ODD_FIELD / 2)} matches`,
      )
    }

    // ----- GO LIVE — the assertion this test exists for -----------------------
    // An odd swiss field's fixtures seat six of its seven entrants, and draw currency
    // used to read that shortfall as an entry that landed after the cut: the draw was
    // `stale`, and go-live answered 409 with a refusal no re-cut could clear. So the
    // transition's own status is asserted, not merely that a button changed.
    const transitionPost = page.waitForResponse(
      (r) => r.url().endsWith('/transitions') && r.request().method() === 'POST',
    )
    await detail.startButton.click()
    const transitionResponse = await transitionPost
    expect(
      transitionResponse.status(),
      `going live was refused: ${await transitionResponse.text()}`,
    ).toBe(201)
    // Two more independent words on the same fact: the header now offers the only edge a
    // live tournament has, and the inline refusal a rejected transition lands on is
    // empty. Without the second, a 409 would surface as a button that never appeared.
    await expect(detail.endButton).toBeVisible()
    await expect(detail.lifecycleNotice).toBeHidden()

    // ----- …and going live paired nothing new --------------------------------
    // Materializing the draw turns *ready* fixtures into matches; it does not seat
    // anybody. Round 1's lines now carry their match link and status, so they are no
    // longer compared as text — but the later rounds must still be forthcoming, which is
    // the statement that go-live did not quietly fill a round nothing has paired yet.
    await expect(detail.swissRoundFixtures(eventId, 1)).toHaveCount(
      Math.floor(ODD_FIELD / 2),
    )
    for (let round = 2; round <= ROUNDS; round += 1) {
      await expect(detail.swissRound(eventId, round)).toHaveCount(0)
      await expect(detail.swissRoundForthcoming(eventId, round)).toBeVisible()
    }

    await Promise.all(entrants.map((entrant) => entrant.ctx.dispose()))
  })
})
