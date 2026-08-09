import { test, expect } from '@playwright/test'
import { faker } from '@faker-js/faker'

import { TournamentDetailPage } from '../page-objects/tournament-detail.page'
import { guestFromContext } from '../support/match-api'
import { grantBetaTester } from '../support/rbac-grant'
import {
  createTournament,
  findEventByName,
  getEventPools,
  getScheduleDetail,
  seedEntrants,
  type TableSpec,
} from '../support/tournament-api'
import { playEvent } from '../support/tournament-play'

/** The event the director authors in the browser, and the handle the spec finds it by
 * afterwards — its id is minted server-side and never crosses back through the UI. */
const EVENT_NAME = 'Open Singles'

/** The draw type's **server-authored** label. The picker renders the served catalogue
 * (ADR 20260726), so this string is the seed row's `name` column, not the client's. */
const DRAW_TYPE_LABEL = 'Round-robin then knockout'

/** `P` — three pools, which is the smallest number at which the format's cross-pool
 * seeding rule has anything to say (with one pool the guarantee is waived, with two it
 * is nearly free). */
const POOL_COUNT = 3
/** `K` — the qualifiers per pool. The number this whole spec exists to get onto the
 * wire: an `rr-then-ko` create body without it is a **422** at the request boundary.
 *
 * **Two, and the director types it.** The form supplies the derived `ceil(8 / P)` for an
 * event that carries no count the server would accept, so this event would go in with 3
 * if nobody touched the row — and three out of a pool of three is every entrant
 * advancing. Half the assertions below are about the three who do *not*. */
const QUALIFIERS_PER_POOL = 2
/** `N` — nine entrants, dealt three to a pool. Enough to satisfy the cut's two
 * entrant-dependent refusals (`K ≤ ⌊N/P⌋` = 3, and `P × K ≥ 2`) with room to spare, and
 * enough that each pool is a real round-robin rather than a single pairing. */
const ENTRANT_COUNT = 9

/** The names the editor's pool section mints, in the order it adds them — the director's
 * order, and therefore the `position` order the server stamps and the draw must read in.
 * Written down here because it is what every ordering assertion below compares against. */
const POOL_NAMES = ['Pool A', 'Pool B', 'Pool C']

/** `B` — the bracket the cut must derive: the smallest power of two that holds the
 * `P × K` = 6 qualifiers. **Eight, not sixteen** — the bracket is sized from the
 * qualifier count, never from the entrant count (ADR 20260727: "derived, never
 * configured"), so a bracket with a fourth round would mean the server had sized it off
 * `N` and the two numbers had been allowed to contradict each other. */
const BRACKET_ROUNDS = 3
/** Six qualifiers into eight slots is two byes, and **a bye is the ABSENCE of a
 * fixture** (ADR-0786) — so round one holds two fixtures, not four. */
const ROUND_ONE_FIXTURES = 2

/** How many matches each stage is: three pools of three is `3 × C(3,2)` = **nine**, and
 * an eight-slot bracket holding six qualifiers is 2 + 2 + 1 = **five** (the two byes cost
 * no fixture). Asserted against what `playEvent` actually decided, so a stage that
 * quietly materialized fewer matches than it owes is a red here — the "N passed against
 * N collected" check, one layer down. */
const POOL_MATCHES = 9
const KNOCKOUT_MATCHES = 5

/**
 * **Who the snake deals into each pool**, by registration index (`_snake`, ADR-0786):
 * nine entrants across three pools is one pass out, one back, one out again, so Pool A
 * takes registrations 0, 5 and 6; Pool B 1, 4 and 7; Pool C 2, 3 and 8.
 *
 * Written down rather than read back off the draw, because the qualifier set below is
 * *derived* from it: who advances is "the top `K` of each pool", and that is only a
 * statement a test can make in advance if it knows who is in each pool. Asserting it on
 * the page is a bonus — the deal following the pool order is `tournament-pool-order`'s
 * subject at ten pools, and this is not a second copy of that proof.
 */
const POOL_MEMBERS: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 5, 6],
  [1, 4, 7],
  [2, 3, 8],
]

/** The six who **qualify**, by registration index, and the three who do not.
 *
 * `playEvent`'s winner rule is "the earlier-registered entrant wins", so a pool's
 * finishing order is its members in registration order and its qualifiers are the first
 * `K` of them. Flattened out of `POOL_MEMBERS`, never retyped: a hand-written list could
 * drift from the deal it is supposed to follow, and would then be asserting a coincidence.
 */
const QUALIFIERS = POOL_MEMBERS.flatMap((members) =>
  members.slice(0, QUALIFIERS_PER_POOL),
)
const ELIMINATED = POOL_MEMBERS.flatMap((members) =>
  members.slice(QUALIFIERS_PER_POOL),
)

/** A uuid — what a pool id is now that a pool is a real row with a `gen_random_uuid()`
 * primary key (ADR 20260801). Asserted on the seed so that "the pool ids are the
 * server's" is established before the spec starts leaning on it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Three tables, one per pool, so the tournament has a venue catalogue of a realistic
 * shape. The editor's pool section reserves none of them (a draw is cut without regard to
 * tables — placement is the scheduler's job), so they are scenery here, not scaffolding. */
const TABLES: ReadonlyArray<TableSpec> = [
  { label: 'Table 1', court: 'A' },
  { label: 'Table 2', court: 'B' },
  { label: 'Table 3', court: 'C' },
]

/**
 * **Round-robin then knockout, through the whole composed stack** (#1227, ADR
 * "rr-then-ko cuts both stages upfront and seeds qualifiers rematch-free"; #1226, ADR
 * 20260801 "a pool belongs to its event").
 *
 * A director creates a tournament, authors an `rr-then-ko` event **in the browser** with
 * a qualifiers-per-pool count and three pools, publishes, has nine players entered, cuts
 * the draw across three **server-minted** pools, takes the tournament live, and the event
 * is played out to a champion — the pool stage seating its six qualifiers into a bracket
 * that was cut before anyone played, and the bracket crowning one of them.
 *
 * ## Why this spec is the one that matters for this format
 *
 * Every other gate in this arc watched a *mock* answer. The MSW store, the web-client
 * Playwright suite and the dev server all accept whatever body the client composes, so
 * all three stayed green while the client shipped a draw type whose create body the real
 * API refused with a 422 — the client named `rr-then-ko` and sent no
 * `qualifiers_per_pool`; the server's draw-settings union requires one on that arm and
 * on no other. Nothing that stubs the network can see that, because the disagreement is
 * *between* the two halves. So this spec drives the seam for real, twice over:
 *
 * 1. **The create.** The event is authored through the editor sheet, so the body on the
 *    wire is the one `drawSettingsToApi` builds — and the spec asserts the POST's
 *    status is **201**, not merely that something appeared. A 422 fails here, naming
 *    itself, rather than surfacing three steps later as a missing event.
 * 2. **The read-back.** The server is asked what it stored: `draw_type: rr-then-ko` and
 *    `qualifiers_per_pool: 2`. A 201 alone would also be returned by a server that
 *    accepted the create and dropped K on the floor.
 *
 * ## And the bracket must exist at cut time
 *
 * The other half of that ADR is that **both stages are cut in one stroke**: `plan_initial`
 * emits the pool fixtures *and* the whole bracket, every side of it TBD. That is not an
 * optimization — an `advance()` can only ever fill a side of an *existing* fixture
 * (`SideFill`), so a bracket that did not exist at the cut could never come into being
 * at all. Pools without a bracket is therefore a real product failure and not a
 * selector miss: the second stage would be unreachable for the life of the event.
 *
 * ## The pools are the SERVER's now, and the draw is dealt across them in ITS order
 *
 * A pool used to be a client-minted string inside a JSONB column; it is a row with a
 * `gen_random_uuid()` primary key and an explicit `position` (ADR 20260801). Every claim
 * this spec makes about the pooled stage therefore has to be keyed on ids the *server*
 * chose, and the order has to be the one the director typed rather than any order those
 * ids happen to sort in. Three readings say so, at three different depths:
 *
 * * **stored** — the three pools read back off the create response are uuids at positions
 *   0, 1, 2, named `Pool A`, `Pool B`, `Pool C` in the order the editor added them;
 * * **on the wire** — the detail's fixtures come back grouped by pool in position order,
 *   so the pool ids' first appearances read as those three ids, in that order;
 * * **on the page** — each pool section is keyed by its uuid, the headings read top to
 *   bottom in the director's order, and the entrants under each are the ones the snake
 *   dealt there.
 *
 * ## …and the qualifiers reach the bracket
 *
 * The claim no unit test makes. The api tests prove `advance()` seats a finished pool's
 * qualifiers into their predetermined slots; the web-client tests prove a bracket renders
 * the sides it is handed. Only here does a real pool, decided by real matches through the
 * real completion hook, put a real name into a real bracket slot — so the spec plays the
 * pool stage out and then asserts the bracket names **exactly** the six who qualified and
 * **none** of the three who did not, on a bracket that named nobody at all an hour before.
 * Then the knockout is played too, and the card crowns the champion the bracket produced.
 *
 * ## Seed vs UI split
 *
 * Inert scaffolding over the API (`support/tournament-api.ts`, `support/tournament-play.ts`):
 * the tournament shell, its table catalogue, the nine entrants — director-entry, which has
 * no web UI, and nine browser sign-ins to test a *draw* would be nine chances to fail for
 * an unrelated reason — and the fourteen matches, which `tournament-lifecycle.spec.ts`
 * already drives through the score-entry UI once, deliberately. Load-bearing steps in the
 * browser: authoring the event and its draw configuration, publishing, cutting the draw,
 * going live, and every reading of the draw, the bracket and the champion.
 *
 * ## RBAC
 *
 * As in `tournament-lifecycle.spec.ts`: a minted user holds only the permissionless
 * default role, so `grantBetaTester` hands the director the tournament bundle over the
 * stack's own `postgres` container before any tournament write. Skipped against an
 * external `E2E_BASE_URL` stack, where the caller owns provisioning.
 */
test.describe('Tournament — rr-then-ko draw', () => {
  test('a director cuts an rr-then-ko draw across three pools, and it is played to a champion', async ({
    page,
    baseURL,
  }) => {
    // Nine minted guests, nine director-entries, a real draw cut and fourteen real
    // matches through the completion hook (each one advancing the draw and re-solving the
    // schedule on the stack's own worker), on top of the ordinary page work.
    test.setTimeout(600_000)
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    // The director IS the browser's own session, so page navigations run as them.
    const director = await guestFromContext(page.request)
    grantBetaTester(director.username)

    // ----- the shell, over the API: a tournament and its tables, no events ----
    const name = `RRKO ${faker.string.alphanumeric(8)}`
    const { tournamentId } = await createTournament(director, name, {
      tables: TABLES,
    })

    const detail = await TournamentDetailPage.navigateTo(page, tournamentId)
    // `toContainText`, not `toHaveText`: the hero sets its own full stop after the name.
    //
    // The long timeout is for the FIRST navigation only, and it is about the stack
    // rather than the app: the composed web-client is a Vite **dev** server, so the very
    // first request for a route pays for transforming it on demand — and under the
    // suite's parallel workers that first paint can take well past the 5s default. Every
    // later assertion here keeps the default, because by then the route is compiled.
    await expect(detail.title).toContainText(name, { timeout: 60_000 })

    // ----- author the rr-then-ko event, in the browser ------------------------
    const editor = await detail.openNewEvent()
    await editor.nameInput.fill(EVENT_NAME)
    await editor.chooseDrawType(DRAW_TYPE_LABEL)
    // The **Draw structure tab** exists ONLY for this draw type — it is absent, not
    // disabled, for a format with no knockout stage to qualify for (ADR 20260808). So its
    // appearance is the proof the picker's choice reached the form, before anything is
    // submitted. The qualifier box on Basics used to carry that proof; the setting moved
    // onto this tab, and the tab inherited it.
    await expect(editor.tab('Draw structure')).toBeVisible()

    // **The pools FIRST**, because the qualifier count is derived from them.
    await editor.addPools(POOL_COUNT)

    // **K is typed, and this spec is about the typed one.** A director who never touches
    // the row now gets the derived count, which across three pools is `ceil(8 / 3)` = 3 —
    // and 3 qualifiers out of a pool of three is every entrant advancing. That draw has no
    // eliminated three for the bracket to exclude and a pool stage that decides nothing,
    // which is precisely the claim below (`the bracket names exactly the six who qualified
    // and none of the three who did not`). So the director takes the setting and types 2.
    //
    // Taking it also seeds the box with that 3, which is why the number is typed *after*
    // the pools exist and not before: seeded against one pool it would have been 8.
    const drawStructure = await editor.openDrawStructure()
    await drawStructure.setManually('Qualifiers per pool', QUALIFIERS_PER_POOL)

    // THE 422 GATE. The create body is the client's own, and its status is asserted
    // directly: a body missing `qualifiers_per_pool` is refused at the request boundary,
    // and this is the assertion that says so in those terms. It is also the gate the pool
    // ids cross — the editor mints none, so a client that still did would be refused here
    // for `body.pools[0].id` instead.
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

    // ----- and the SERVER holds the configuration the director typed ----------
    // A 201 says the body was accepted; only the read-back says K survived it.
    const event = await findEventByName(director, tournamentId, EVENT_NAME)
    expect(event.draw_type).toBe('rr-then-ko')
    expect(event.qualifiers_per_pool).toBe(QUALIFIERS_PER_POOL)
    const eventId = event.id

    // ----- …and three pools the SERVER minted, in the order they were added ---
    // Positions 0, 1, 2 against the editor's own `Pool A`, `Pool B`, `Pool C`. The client
    // sent neither an id nor a position (`PoolWrite` has a field for neither), so both
    // columns here are the server's own work — and the ids being uuids is what makes
    // every "by pool id" assertion below a statement about the server's pools.
    const pools = await getEventPools(director, tournamentId, eventId)
    expect(pools.map((pool) => pool.name)).toEqual(POOL_NAMES)
    expect(pools.map((pool) => pool.position)).toEqual([0, 1, 2])
    for (const pool of pools) expect(pool.id).toMatch(UUID)

    // ----- publish, then fill the field --------------------------------------
    await detail.publishTournament()
    await expect(detail.startButton).toBeVisible()

    const entrants = await seedEntrants(
      director,
      baseURL!,
      tournamentId,
      eventId,
      ENTRANT_COUNT,
    )
    // How many entries landed is asked of the SERVER, not counted off the roster: the
    // card lists eight chips and collapses the rest into "+1 more", so a list-item count
    // here would be nine for the wrong reason — the truncation, not the field.
    const filled = await findEventByName(director, tournamentId, EVENT_NAME)
    expect(filled.entered).toBe(ENTRANT_COUNT)

    await detail.reload(tournamentId)
    // The browser's own word that the field is on the page at all, before it is drawn.
    await expect(detail.entrantsList(EVENT_NAME)).toContainText(entrants[0].username)

    // ----- cut the draw: both stages, in one stroke --------------------------
    const drawPost = page.waitForResponse(
      (r) => r.url().endsWith('/draw') && r.request().method() === 'POST',
    )
    await detail.generateDrawButton(EVENT_NAME).click()
    const drawResponse = await drawPost
    expect(
      drawResponse.status(),
      `cutting the draw was refused: ${await drawResponse.text()}`,
    ).toBe(201)

    // ----- stage one: three pools, keyed and ordered by the server -----------
    await expect(detail.poolDraws(eventId)).toHaveCount(POOL_COUNT)
    // Top to bottom in the director's order. One statement pinning both the count and the
    // order — a draw whose sections came back in any other order reds here. (What that
    // order is *derived from* — `position`, and never the pool ids — is
    // `tournament-pool-order.spec.ts`'s subject, at the ten pools it takes to tell the two
    // apart reliably.)
    await expect(detail.poolDrawHeadings(eventId)).toHaveText(POOL_NAMES)
    for (const [index, pool] of pools.entries()) {
      // The section is keyed by the pool's uuid, so this asks for the server's pool by the
      // server's id and would find nothing if the page keyed its sections any other way.
      await expect(detail.poolDraw(eventId, pool.id)).toBeVisible()
      // Nine entrants snake-dealt across three pools is three apiece — the pool
      // membership is derived from the pool's own fixtures (ADR-0786), so this is also
      // the statement that each pool really got a round-robin of its own, and that the
      // deal followed the same pool order the headings above are in.
      await expect(
        detail.poolEntrants(eventId, pool.name),
        `${pool.name} holds the wrong entrants — the draw was dealt in the wrong pool order`,
      ).toHaveText(POOL_MEMBERS[index].map((i) => entrants[i].username))
    }

    // ----- …and the WIRE carried that order to get here -----------------------
    // The detail's fixtures come back ordered by their pool's position, so the pool ids in
    // first-appearance order are the server's own statement of the event's pool order —
    // the one the page above rendered, read straight off the payload that fed it.
    const schedule = await getScheduleDetail(director, tournamentId)
    const fixtures = schedule.events.find((e) => e.id === eventId)?.fixtures ?? []
    expect([
      ...new Set(
        fixtures.flatMap((fixture) =>
          fixture.pool_id === null ? [] : [fixture.pool_id],
        ),
      ),
    ]).toEqual(pools.map((pool) => pool.id))

    // ----- stage two: the bracket, present already, and entirely unknown -----
    await expect(detail.bracket(eventId)).toBeVisible()
    // Sized from the qualifiers (6 → 8 slots → 3 rounds), never from the entrants
    // (9 → 16 → 4 rounds). The absent fourth round is the load-bearing half.
    await expect(detail.bracketRound(eventId, BRACKET_ROUNDS)).toBeVisible()
    await expect(detail.bracketRound(eventId, BRACKET_ROUNDS + 1)).toHaveCount(0)
    // Two byes, so round one is two fixtures — a bye is an absent fixture, not a row.
    await expect(detail.bracketRound(eventId, 1).getByRole('listitem')).toHaveCount(
      ROUND_ONE_FIXTURES,
    )
    // The final exists and both its sides are unknown: nobody has played, so every
    // knockout side is TBD and the bracket names NO entrant yet. `SideFill` seats them
    // below, pool by pool, into slots that already exist.
    const final = detail.bracketRound(eventId, BRACKET_ROUNDS).getByRole('listitem')
    await expect(final).toHaveCount(1)
    await expect(final).toHaveText(/TBD\s*vs\s*TBD/)
    for (const entrant of entrants) {
      await expect(detail.bracket(eventId)).not.toContainText(entrant.username)
    }

    // ----- go live: the pool fixtures become real matches --------------------
    await detail.startTournament()
    await expect(detail.endButton).toBeVisible()

    // ----- play the POOL STAGE, and only it, over the API --------------------
    // Stopping here is the whole point of the `'pools'` stage: the moment worth looking
    // at — pools decided, qualifiers seated, nobody knocked out — does not exist if the
    // helper plays on. The earlier-registered entrant always wins, so each pool's
    // qualifiers are exactly `POOL_MEMBERS`' first two.
    expect(
      await playEvent(director, tournamentId, eventId, entrants, 'pools'),
      'the pool stage must materialize one match per pairing',
    ).toBe(POOL_MATCHES)

    // ----- the qualifiers are SEATED in the bracket that named nobody --------
    await detail.reload(tournamentId)
    for (const index of QUALIFIERS) {
      await expect(
        detail.bracket(eventId),
        `${entrants[index].username} qualified but is not in the bracket`,
      ).toContainText(entrants[index].username)
    }
    // The half that makes it an assertion about *seeding* rather than about names
    // appearing: the three who did not qualify are still absent, so the bracket was
    // filled from each pool's top K and not from the pool.
    for (const index of ELIMINATED) {
      await expect(
        detail.bracket(eventId),
        `${entrants[index].username} did not qualify but is in the bracket`,
      ).not.toContainText(entrants[index].username)
    }

    // ----- play the KNOCKOUT out, and the card crowns its champion -----------
    expect(
      await playEvent(director, tournamentId, eventId, entrants, 'all'),
      'the bracket must be five matches: two byes cost no fixture',
    ).toBe(KNOCKOUT_MATCHES)

    await detail.reload(tournamentId)
    // The two-stage callout, never the round-robin one: in this format leading a pool
    // wins nothing, so the name here is the knockout FINAL's winner. Under the winner
    // rule that is the first entrant to register, who won every match they played.
    await expect(detail.twoStageChampion(eventId)).toBeVisible()
    await expect(detail.twoStageChampion(eventId)).toContainText(entrants[0].username)

    await Promise.all(entrants.map((entrant) => entrant.ctx.dispose()))
  })
})
