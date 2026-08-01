import { test, expect } from '@playwright/test'
import { faker } from '@faker-js/faker'

import { TournamentDetailPage } from '../page-objects/tournament-detail.page'
import { guestFromContext } from '../support/match-api'
import { grantBetaTester } from '../support/rbac-grant'
import {
  createTournament,
  findEventByName,
  seedEntrants,
  type TableSpec,
} from '../support/tournament-api'

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
 * wire: an `rr-then-ko` create body without it is a **422** at the request boundary. */
const QUALIFIERS_PER_POOL = 2
/** `N` — nine entrants, dealt three to a pool. Enough to satisfy the cut's two
 * entrant-dependent refusals (`K ≤ ⌊N/P⌋` = 3, and `P × K ≥ 2`) with room to spare, and
 * enough that each pool is a real round-robin rather than a single pairing. */
const ENTRANT_COUNT = 9

/** `B` — the bracket the cut must derive: the smallest power of two that holds the
 * `P × K` = 6 qualifiers. **Eight, not sixteen** — the bracket is sized from the
 * qualifier count, never from the entrant count (ADR 20260727: "derived, never
 * configured"), so a bracket with a fourth round would mean the server had sized it off
 * `N` and the two numbers had been allowed to contradict each other. */
const BRACKET_ROUNDS = 3
/** Six qualifiers into eight slots is two byes, and **a bye is the ABSENCE of a
 * fixture** (ADR-0786) — so round one holds two fixtures, not four. */
const ROUND_ONE_FIXTURES = 2

/** Three tables, one per pool, so the seeded catalogue can furnish the pools the
 * director adds in the editor. */
const TABLES: ReadonlyArray<TableSpec> = [
  { id: 't1', label: 'Table 1', court: 'A' },
  { id: 't2', label: 'Table 2', court: 'B' },
  { id: 't3', label: 'Table 3', court: 'C' },
]

/**
 * **Round-robin then knockout, through the whole composed stack** (#1227, ADR
 * "rr-then-ko cuts both stages upfront and seeds qualifiers rematch-free").
 *
 * A director creates a tournament, authors an `rr-then-ko` event **in the browser** with
 * a qualifiers-per-pool count and three pools, publishes, has nine players entered, cuts
 * the draw, and the page shows **three pools AND a knockout bracket**.
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
 * The other half of the ADR is that **both stages are cut in one stroke**: `plan_initial`
 * emits the pool fixtures *and* the whole bracket, every side of it TBD. That is not an
 * optimization — an `advance()` can only ever fill a side of an *existing* fixture
 * (`SideFill`), so a bracket that did not exist at the cut could never come into being
 * at all. Pools without a bracket is therefore a real product failure and not a
 * selector miss: the second stage would be unreachable for the life of the event.
 *
 * ## Seed vs UI split
 *
 * Inert scaffolding over the API (`support/tournament-api.ts`): the tournament shell,
 * its table catalogue, and the nine entrants — director-entry, which has no web UI, and
 * nine browser sign-ins to test a *draw* would be nine chances to fail for an unrelated
 * reason. Load-bearing steps in the browser: authoring the event and its draw
 * configuration, publishing, and cutting the draw.
 *
 * ## RBAC
 *
 * As in `tournament-lifecycle.spec.ts`: a minted user holds only the permissionless
 * default role, so `grantBetaTester` hands the director the tournament bundle over the
 * stack's own `postgres` container before any tournament write. Skipped against an
 * external `E2E_BASE_URL` stack, where the caller owns provisioning.
 */
test.describe('Tournament — rr-then-ko draw', () => {
  test('a director cuts an rr-then-ko draw and the page shows three pools and a bracket', async ({
    page,
    baseURL,
  }) => {
    // Nine minted guests, nine director-entries and a real CP-SAT-free draw cut, on top
    // of the ordinary page work — comfortably past the 30s default.
    test.setTimeout(120_000)
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    // The director IS the browser's own session, so page navigations run as them.
    const director = await guestFromContext(page.request)
    grantBetaTester(director.username)

    // ----- the shell, over the API: a tournament and its tables, no events ----
    const name = `RRKO ${faker.string.alphanumeric(8)}`
    const tournamentId = await createTournament(director, name, { tables: TABLES })

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
    // The qualifier box exists ONLY for this draw type — it is absent, not disabled,
    // for a format with no knockout stage to qualify for. So its appearance is the
    // proof the picker's choice reached the form, before anything is submitted.
    await expect(editor.qualifiersInput).toBeVisible()
    await editor.setQualifiersPerPool(QUALIFIERS_PER_POOL)
    await editor.addPools(POOL_COUNT)

    // THE 422 GATE. The create body is the client's own, and its status is asserted
    // directly: a body missing `qualifiers_per_pool` is refused at the request boundary,
    // and this is the assertion that says so in those terms.
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

    // ----- publish, then fill the field --------------------------------------
    await detail.publishButton.click()
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

    // ----- stage one: three pools, three players each ------------------------
    await expect(detail.poolDraws(eventId)).toHaveCount(POOL_COUNT)
    for (const poolName of ['Pool A', 'Pool B', 'Pool C']) {
      const pool = detail.poolDrawNamed(eventId, poolName)
      await expect(pool).toBeVisible()
      // Nine entrants snake-dealt across three pools is three apiece — the pool
      // membership is derived from the pool's own fixtures (ADR-0786), so this is also
      // the statement that each pool really got a round-robin of its own.
      await expect(
        pool.getByRole('list', { name: `Entrants in ${poolName}` }).getByRole('listitem'),
      ).toHaveCount(ENTRANT_COUNT / POOL_COUNT)
    }

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
    // later, pool by pool, into slots that already exist.
    const final = detail.bracketRound(eventId, BRACKET_ROUNDS).getByRole('listitem')
    await expect(final).toHaveCount(1)
    await expect(final).toHaveText(/TBD\s*vs\s*TBD/)
    for (const entrant of entrants) {
      await expect(detail.bracket(eventId)).not.toContainText(entrant.username)
    }

    await Promise.all(entrants.map((entrant) => entrant.ctx.dispose()))
  })
})
