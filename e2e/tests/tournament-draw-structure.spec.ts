import { test, expect } from '@playwright/test'
import { faker } from '@faker-js/faker'

import { TournamentDetailPage } from '../page-objects/tournament-detail.page'
import { guestFromContext } from '../support/match-api'
import { grantBetaTester } from '../support/rbac-grant'
import {
  addEvent,
  createTournament,
  findEventByName,
  type PoolSpec,
} from '../support/tournament-api'

/** The two-stage event, and the handle every reading below finds it by. */
const RR_KO_EVENT = 'Two-stage Open'
/** The plain round-robin standing beside it — the control. Named so that neither event's
 * name is a substring of the other's, since both are addressed by name on one page. */
const ROUND_ROBIN_EVENT = 'One-stage Open'

/** The event's **cap**, which is the field the tab derives against (a capped event
 * previews against its cap; an uncapped one against a synthetic 16). Thirty-two because
 * it is the reference's own "nothing set" state, and because it divides by four exactly —
 * so the uneven notice is absent and any `6–8` on screen is a real failure. */
const FIELD_CAP = 32
/** How many **pool rows** the event carries. Today's behaviour, and the automatic source
 * of the pool count: one reservation is one pool (ADR 20260808). */
const POOL_COUNT = 4
/** The four pool rows, reserving **no** tables — a draw is cut without regard to tables,
 * and an empty `table_ids` is what the editor's own pool section sends. Four tables
 * shared four ways would be scenery this spec never looks at. */
const POOLS: ReadonlyArray<PoolSpec> = ['A', 'B', 'C', 'D'].map((letter) => ({
  name: `Pool ${letter}`,
  tableLabels: [],
}))

/** **K as the event STORES it** — required with no default on the server's `rr-then-ko`
 * arm, so the seed must send it or the create is a 422 naming the field.
 *
 * ⚠️ It is **not** what the tab reads. Nothing on the Draw structure tab looks at the
 * stored column this slice: every number there comes from the derivation, which aims at
 * an eight-player knockout and lands on `ceil(8 / 4)` = 2 for this event. The two agree
 * here, which is why the row is not asserted as proof of anything about storage. Chore 3e
 * moves the setting onto this tab for good and makes them one number. */
const STORED_QUALIFIERS_PER_POOL = 2

/** What the derivation makes of `32` across `4`, and the only numbers this spec asserts.
 * Worked from the reference's own arithmetic (`docs/designs/rr-then-ko-draw-structure`):
 * a balanced split of 32 into 4 is `8, 8, 8, 8`; the automatic qualifier count is
 * `ceil(8 / 4)` = 2; the bracket is `4 × 2` = 8, which is already a power of two and so
 * takes no byes; and the pool stage plays `4 × C(8,2)` = 112 matches. */
const POOL_SIZE = 8
const QUALIFIERS_ADVANCING = 2
const BRACKET_SIZE = 8
const POOL_MATCHES = 112

/** The equation, whole. Safe to assert as one string — unlike the cards below it, every
 * literal in that line carries its own spaces (`textContent` inserts none of its own, so
 * a pool card reads `Pool A8playerstop 2 advance` and is stated one fact at a time). */
const EQUATION = `${FIELD_CAP} players ÷ ${POOL_COUNT} pools = ${POOL_SIZE} per pool`

/** The source line under the Pool count row, **verbatim**.
 *
 * The glyphs are the reference's and are load-bearing: a middle dot (`·`, U+00B7), and a
 * **straight** apostrophe (U+0027) in `today's` — the one exception to the reference's
 * right-single-quote rule, which the design README states at the top and this string
 * exists to pin. A test that normalises either way is a test that stops noticing. */
const POOL_COUNT_SOURCE = `${POOL_COUNT} pool reservations · today's behaviour`

/** Where the preview field came from. `{n}-player cap` for a capped event — the honest
 * label an uncapped one gets instead is `preview-field.ts`'s deviation from the reference
 * and belongs to a different event than this one. */
const PREVIEW_BASIS = `${FIELD_CAP}-player cap`

/**
 * **The Draw structure tab, through the whole composed stack** (#1320).
 *
 * A director opens a round-robin-then-knockout event they have already saved, and reads
 * the draw their four pool rows and their 32-player cap already imply: four pools of
 * eight, two out of each, an eight-player bracket with no byes, and 112 pool matches to
 * decide it.
 *
 * ## What only this suite can say
 *
 * The arithmetic is already proved. `data/draw-structure.test.ts` runs the derivation's
 * whole vector table against a Python twin, and the component tests render each part of
 * the tab from a fixture. Both stop at the same edge: they hand the derivation numbers
 * that a *test* chose.
 *
 * This spec hands it numbers the **server** chose. The cap is a `max_players` column, the
 * pool count is four rows in `tournament_event_pools`, and both reach the tab only by
 * being serialized onto `GET /v1/tournaments/{id}`, parsed at the client's fetch
 * boundary, and mapped into the editor's draft. Every step of that is real here and
 * mocked everywhere else — so `112 pool matches` on this screen is the statement that the
 * real payload, decoded through the real fetch stack, produces the reference's number.
 *
 * ## …and the tab is CONDITIONAL, which is the regression worth a control
 *
 * The tab exists only while the draw type is `rr-then-ko` (ADR 20260808). A round-robin
 * has no bracket to aim at, so a Draw structure tab on one would invite a director to
 * configure a draw their event will never cut. The happy path alone cannot see that
 * going wrong, so the tournament carries a **second, plain round-robin event** and the
 * spec asserts the tab is absent from its editor — after asserting that editor opened at
 * all, since a sheet that never opened offers no tabs of any kind.
 *
 * ## Seed vs UI split
 *
 * Both events are seeded over the real API (`support/tournament-api.ts`): they are the
 * scaffolding, and what is under test is what the editor *renders* from them. The create
 * payload is deliberately somebody else's subject — `tournament-rr-then-ko.spec.ts`
 * authors its event through the sheet, because the body that editor builds is the seam
 * that arc's 422 lived in. Every reading below is the browser's.
 */
test.describe('Tournament — the rr-then-ko draw structure', () => {
  test('a director reads the draw their pool rows already imply, and only this format offers it', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    // The director IS the browser's own session, so page navigations run as them and the
    // event cards carry the owner's `Edit …` open target rather than a viewer's `View …`.
    const director = await guestFromContext(page.request)
    grantBetaTester(director.username)

    // ----- the shell, over the API: two events, one tournament ---------------
    const name = `Draw structure ${faker.string.alphanumeric(8)}`
    const { tournamentId, tables } = await createTournament(director, name)

    await addEvent(director, tournamentId, tables, {
      name: RR_KO_EVENT,
      drawType: 'rr-then-ko',
      qualifiersPerPool: STORED_QUALIFIERS_PER_POOL,
      maxPlayers: FIELD_CAP,
      pools: POOLS,
    })
    // The control, and the reason it is on the SAME tournament: two events one click
    // apart is the sharpest form of "this format has the tab and that one does not".
    await addEvent(director, tournamentId, tables, {
      name: ROUND_ROBIN_EVENT,
      pools: [{ name: 'Pool A', tableLabels: [] }],
    })

    // ----- the SERVER holds what the tab is about to be derived from ---------
    // Read back before a browser is involved, so a wrong number on screen below can only
    // be the client's doing. A 201 alone would also come back from a server that stored
    // the event and dropped its cap or its pools.
    const stored = await findEventByName(director, tournamentId, RR_KO_EVENT)
    expect(stored.draw_type).toBe('rr-then-ko')
    expect(stored.qualifiers_per_pool).toBe(STORED_QUALIFIERS_PER_POOL)

    const detail = await TournamentDetailPage.navigateTo(page, tournamentId)
    // `toContainText`, not `toHaveText`: the hero sets its own full stop after the name.
    // The long timeout is for the FIRST navigation only, and it is about the stack rather
    // than the app — the composed web-client is a Vite *dev* server, so the first request
    // for a route pays for transforming it on demand.
    await expect(detail.title).toContainText(name, { timeout: 60_000 })

    // ----- open the two-stage event's editor, and its fifth tab --------------
    const editor = await detail.openEvent(RR_KO_EVENT)
    const drawStructure = await editor.openDrawStructure()
    await expect(drawStructure.section).toBeVisible()
    await expect(drawStructure.heading).toHaveText(
      'Set what matters. We’ll work out the rest.',
    )

    // ----- the field the whole tab is derived against ------------------------
    // The cap, as a number and in words. Everything below is a consequence of it, so a
    // wrong field here would make every later assertion a report of the same one fault.
    await expect(drawStructure.fieldSize).toHaveText(String(FIELD_CAP))
    await expect(drawStructure.previewBasis).toHaveText(PREVIEW_BASIS)

    // ----- the equation: the whole draw in one line --------------------------
    await expect(drawStructure.previewEquation).toHaveText(EQUATION)

    // ----- four pools of eight, two out of each ------------------------------
    await expect(drawStructure.previewPoolCards).toHaveCount(POOL_COUNT)
    for (const letter of ['A', 'B', 'C', 'D']) {
      const card = drawStructure.previewPoolCard(letter)
      // One fact per assertion: `textContent` puts no space between block elements, so
      // the card reads `Pool A8playerstop 2 advance` as one string and a whole-card
      // `toHaveText` would be pinning that concatenation instead of the copy.
      await expect(card).toContainText(`${POOL_SIZE}`)
      await expect(card).toContainText('players')
      await expect(card).toContainText(`top ${QUALIFIERS_ADVANCING} advance`)
      // The negative half: a pool that cannot be played says so in words, and none of
      // these can be — eight players supplying two qualifiers is comfortable.
      await expect(card).not.toContainText('Too small')
    }

    // ----- …feeding a bracket that needs no byes -----------------------------
    await expect(drawStructure.previewKnockout).toContainText(
      `${BRACKET_SIZE}-player bracket`,
    )
    // Eight qualifiers into an eight-slot bracket. The `No …` wording is the state, not
    // an absence of text: a bracket that took byes says `{n} first-round byes` here.
    await expect(drawStructure.previewKnockout).toContainText('No first-round byes')
    // `4 × C(8,2)`. The one number on this screen that no other surface states, and the
    // reference's own worked example.
    await expect(drawStructure.previewKnockout).toContainText(
      `${POOL_MATCHES} pool matches`,
    )

    // ----- the verdict, which is the tab's one summary -----------------------
    // Read together, because the heading and the badge are one decision: a `Sound` badge
    // over `This draw can’t work yet` would be worse than either alone.
    await expect(drawStructure.previewVerdict).toHaveText('Ready to save')
    await expect(drawStructure.previewBadge).toHaveText('Sound')

    // ----- and the Pool count row says where its number came from ------------
    // The row a director looks at to learn that nobody chose this: the value, the badge
    // that says the system owns it, and the sentence naming the pool rows it was read
    // off. Addressed by the setting's name, which is the row's accessible name.
    await expect(drawStructure.settingValue('Pool count')).toHaveText(
      String(POOL_COUNT),
    )
    await expect(drawStructure.settingUnit('Pool count')).toHaveText('pools')
    await expect(drawStructure.settingOwnership('Pool count')).toHaveText('Automatic')
    await expect(drawStructure.settingSource('Pool count')).toHaveText(
      POOL_COUNT_SOURCE,
    )
    // The pools are even, so the size row reads one number and not a `{min}–{max}` range
    // — the fact that keeps the equation above from being an average.
    await expect(drawStructure.settingValue('Pool size')).toHaveText(String(POOL_SIZE))
    await expect(drawStructure.settingUnit('Pool size')).toHaveText('players per pool')

    // ----- the control: a plain round-robin is offered NO such tab -----------
    // Reloaded rather than closing the sheet: the editor is a modal, so its overlay
    // covers the second event's card until it is gone, and a fresh page is the shortest
    // way to be sure of that.
    await detail.reload(tournamentId)
    const plainEditor = await detail.openEvent(ROUND_ROBIN_EVENT)
    // FIRST that the sheet is open at all. Without this, a click that missed would leave
    // a page with no tabs on it, and "no Draw structure tab" would pass for free.
    await expect(plainEditor.tab('Basics')).toBeVisible()
    await expect(plainEditor.tab('Table pools')).toBeVisible()
    await expect(plainEditor.tab('Draw structure')).toHaveCount(0)
    // …and no panel left behind either: the trigger and its content are rendered
    // together, so a tab that vanished while its content stayed would be a blank fifth
    // section a director could still be sent to.
    await expect(plainEditor.drawStructure.section).toHaveCount(0)
  })
})
