import { test, expect, type Page } from '@playwright/test'
import { faker } from '@faker-js/faker'

import { TournamentDetailPage } from '../page-objects/tournament-detail.page'
import { guestFromContext, type Guest } from '../support/match-api'
import { grantBetaTester } from '../support/rbac-grant'
import {
  addEvent,
  createTournament,
  findEventByName,
  patchEventDrawRaw,
  validationDetails,
  type PoolSpec,
  type StoredTable,
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

/** The source line under the Pool size row while nobody owns it: the division that
 * produced it, from the same derivation that produced the number. */
const AUTOMATIC_POOL_SIZE_SOURCE = `${FIELD_CAP} players ÷ ${POOL_COUNT} pools`

// ----- the second spec's numbers: a pool size the DIRECTOR sets ---------------
//
// Kept apart from the four constants above, and not one of them is reused. The whole
// point of the manual scenario is that **every derived number moves**, so a shared
// constant would be a place for the two scenarios to quietly become one.

/** The size the director types over the `8` the row was showing. Sixteen because it
 * halves the pool count rather than nudging it: `2` is unmistakably not the `4` pool
 * rows the event still has, so a reload that showed the old automatic split could not be
 * mistaken for a coincidence. */
const MANUAL_POOL_SIZE = 16
/** What the pool count becomes once the size is the director's: `ceil(32 / 16)`. Still an
 * **automatic** number — taking one setting does not take the one below it. */
const DERIVED_POOL_COUNT = 2
/** `ceil(8 / 2)`, the automatic qualifier count aimed at an eight-player knockout across
 * two pools. Note it is **not** the event's stored K, which is still 2: an automatic
 * qualifier count ignores the stored number, so this is a live reading of the derivation
 * rather than an echo of the seed. */
const DERIVED_QUALIFIERS_ADVANCING = 4
/** `2 × 4` — the same eight-player bracket the automatic draw produced, reached by a
 * different route. Asserted anyway: a bracket that moved would mean the qualifier count
 * and the pool count had not moved together. */
const MANUAL_BRACKET_SIZE = 8
/** `2 × C(16,2)`. The number that says loudest that the manual size took: the automatic
 * draw plays 112 pool matches and this one plays more than twice that. */
const MANUAL_POOL_MATCHES = 240

/** The equation once the director owns the size. */
const MANUAL_EQUATION = `${FIELD_CAP} players ÷ ${DERIVED_POOL_COUNT} pools = ${MANUAL_POOL_SIZE} per pool`
/** The source line under the Pool size row when the director set the target and the
 * system worked out the rest — **verbatim**, right single quote and all. */
const MANUAL_POOL_SIZE_SOURCE = 'You set the target. We derived the pool count.'
/** …and the line under the Pool count row, which now names the division it did rather
 * than the pool rows it used to read off. The `about` is the reference's: a greedy fill
 * does not promise every pool that size. */
const DERIVED_POOL_COUNT_SOURCE = `${FIELD_CAP} players ÷ about ${MANUAL_POOL_SIZE} per pool`

// ----- the third spec's numbers: the configuration #1320 WAS FILED ABOUT ------
//
// A real director took one pool and one qualifier per pool. That sends one player to the
// bracket, so the draw could not be cut — and the app named the wrong cause, hours later,
// at the cut. Kept apart from the two scenarios above for the same reason those are kept
// apart from each other: not one number here is the same question as a number there.

/** **One** pool row, reserving no tables. The pool count is the row count (ADR 20260808),
 * so this single row is the whole of "one pool" — and it is seeded rather than reached
 * through the pool section, because what is under test is the qualifier count. */
const SINGLE_POOL: ReadonlyArray<PoolSpec> = [{ name: 'Pool A', tableLabels: [] }]

/** `32 ÷ 1`. Comfortably playable, and that matters twice: the pool rule is tested first,
 * so a pool that could not be played would mask the bracket refusal entirely — the panel
 * would name the pool and this spec would pass while proving the wrong thing. */
const LONE_POOL_SIZE = FIELD_CAP

/** What the **automatic** qualifier count derives to across one pool: `ceil(8 / 1)` = 8,
 * capped at the smallest pool, which holds 32. Asserted before anything is taken, because
 * it is the reason this scenario needs a manual count at all: the automatic branch clamps
 * to a number it will accept, so an automatically-configured event **cannot** reach the
 * refusal below. Only a count the director typed can, and it is preserved exactly as
 * typed (ADR 20260808). */
const AUTOMATIC_LONE_POOL_QUALIFIERS = 8

/** The K this event is **seeded** with. Three, and deliberately neither the 8 the
 * derivation shows nor the 2 the fix writes: the save at the end is read back off the
 * server, and a seed of 2 would leave `qualifiers_per_pool === 2` true of a server that
 * had dropped the write on the floor. */
const SEEDED_LONE_POOL_QUALIFIERS = 3

/** The number the director types, and the whole of #1320's configuration: one out of one
 * pool. */
const REFUSED_QUALIFIERS = 1
/** …and what the offered fix writes instead. `1 × 2` is a two-player knockout, which is
 * the smallest one that can be drawn. */
const FIXED_QUALIFIERS = 2

/** **The cause, verbatim** — the derivation's own words, and the one assertion this whole
 * spec exists for. A refusal that named a pool count or a scheduling problem would still
 * disable the button, still show a panel and still say `Can’t save`, so every other
 * reading below passes just as happily against the wrong-cause message #1320 reported. */
const ONE_PLAYER_KNOCKOUT_TITLE = 'The knockout would have one player'
/** What to do about it. A right single quote is not in play in this pair; the reference's
 * `U+2019` rule bites on `Can’t save` and on the preview's verdict below. */
const ONE_PLAYER_KNOCKOUT_BODY =
  'One player has nobody to play. Take more qualifiers or run more pools.'
/** The refusal's topline. `U+2019`, as the reference writes every apostrophe but
 * `today's behaviour`. */
const CANT_SAVE = 'Can’t save'
/** The preview's verdict and badge while the draw cannot be played. */
const IMPOSSIBLE_VERDICT = 'This draw can’t work yet'
const IMPOSSIBLE_BADGE = 'Impossible'

/** The one way out this refusal offers, and the line under it. */
const OFFERED_FIX = 'Take top 2'
const OFFERED_FIX_DETAIL = 'Creates a playable knockout.'

/** The line above the footer, which is the disabled button's `aria-describedby` target:
 * the derivation's cause, plus where to fix it. */
const SAVE_BLOCKED_REASON = `${ONE_PLAYER_KNOCKOUT_TITLE}. Fix it on the Draw structure tab.`
/** What the save button reads while it is refusing. A disabled control still saying
 * `Save changes` looks broken; this names the act that would re-enable it. */
const BLOCKED_SAVE_LABEL = 'Fix the structure to save'

/** **The server's sentence for the same cause**, verbatim (`app/draw_structure.py`).
 *
 * Longer than the client's, and deliberately not the same string: the panel also offers a
 * button and the API cannot, so the API's copy carries the way out inside the sentence.
 * What has to match is the **cause**, which both name — one player in the knockout, with
 * nobody to play. */
const SERVER_ONE_PLAYER_KNOCKOUT_REFUSAL =
  'Taking 1 qualifier from a single pool leaves one player in the ' +
  'knockout stage, who would have nobody to play — take more qualifiers ' +
  'from each pool, or configure more pools.'

/**
 * The tournament both specs are about: one `rr-then-ko` event, capped at 32, over four
 * pool rows that reserve no tables — the state the whole tab is derived from.
 *
 * The director **is** the browser's own session (`guestFromContext`), so page navigations
 * run as them and the event card carries the owner's `Edit …` open target rather than a
 * viewer's `View …`.
 *
 * The tournament name is returned because it is the only handle a spec has on the page
 * having rendered at all — the hero's `h1` — and the catalogue because a second event is
 * added against it.
 *
 * **The two overrides are the pool rows and K, and no others.** They are the pair the
 * derivation's whole answer turns on, so a scenario about a different draw shape changes
 * them and leaves the cap, the draw type and the name alone — which is what keeps every
 * number this file asserts traceable to one of the two. Both default to the four-pool
 * event the first two specs read.
 */
async function seedTwoStageTournament(
  page: Page,
  options: {
    readonly pools?: ReadonlyArray<PoolSpec>
    readonly qualifiersPerPool?: number
  } = {},
): Promise<{
  director: Guest
  tournamentId: string
  tables: ReadonlyArray<StoredTable>
  name: string
  eventId: string
}> {
  const director = await guestFromContext(page.request)
  grantBetaTester(director.username)

  const name = `Draw structure ${faker.string.alphanumeric(8)}`
  const { tournamentId, tables } = await createTournament(director, name)

  const { eventId } = await addEvent(director, tournamentId, tables, {
    name: RR_KO_EVENT,
    drawType: 'rr-then-ko',
    qualifiersPerPool: options.qualifiersPerPool ?? STORED_QUALIFIERS_PER_POOL,
    maxPlayers: FIELD_CAP,
    pools: options.pools ?? POOLS,
  })

  return { director, tournamentId, tables, name, eventId }
}

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

    // ----- the shell, over the API: two events, one tournament ---------------
    const { director, tournamentId, tables, name } =
      await seedTwoStageTournament(page)

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

  /**
   * **A pool size the director sets is theirs after a reload — and giving it back sticks
   * too.**
   *
   * ## What only this suite can say
   *
   * That the ownership *mode* is stored. Every other test of this tab hands the tab a
   * mode: `draw-structure-section.test.tsx` renders a fixture that already has one, and
   * the MSW store keeps whatever it is handed. Neither can tell "the director owns this
   * setting" from "the number happens to be that". Only a real PATCH into Postgres and a
   * real `GET` back out can, and the discriminator is the **badge**: a `16` that survived
   * a reload under an `Automatic` badge is a number the system will silently re-derive the
   * next time the field moves — the director's work, lost quietly, which is exactly what
   * ADR 20260808 forbids and what #1320 was filed about.
   *
   * So the badge is asserted every time the number is, and the reload is a real one: a new
   * page, a re-opened editor, a re-opened tab, and nothing left of the first visit but
   * what the server kept.
   *
   * ## Both directions, one test, one seed
   *
   * `Set myself` and `Use automatic` are one setting's two edges, and the second only
   * means anything from a state the first produced. Driving both here keeps every
   * transition the browser's — an API-seeded manual mode would prove the server accepts a
   * body this test composed, which is the thing `tournament-api.ts` declines to do — and
   * pays the tournament seed and the first navigation once.
   *
   * ## The API read-backs are corroboration, not the assertion
   *
   * Two of them, around the two saves, in the shape this file already uses for
   * `draw_type`: they say *where* a failure is (the server dropped it / the client never
   * sent it) rather than leaving a wrong badge to be argued about. The second one carries
   * the ADR's own non-destructive rule — `Use automatic` keeps the director's number and
   * only stops reading it — which no screen states, because the point of it is that the
   * screen goes back to the derived number.
   */
  test('a pool size the director sets survives a save and a reload, badge and all', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    const { director, tournamentId, name } = await seedTwoStageTournament(page)

    const detail = await TournamentDetailPage.navigateTo(page, tournamentId)
    // The long timeout is the composed web-client's first compile of this route, not the
    // app — see the same wait in the spec above.
    await expect(detail.title).toContainText(name, { timeout: 60_000 })

    // ----- 1. nobody owns the pool size yet ----------------------------------
    const editor = await detail.openEvent(RR_KO_EVENT)
    const drawStructure = await editor.openDrawStructure()
    await expect(drawStructure.section).toBeVisible()
    await expect(drawStructure.settingValue('Pool size')).toHaveText(String(POOL_SIZE))
    await expect(drawStructure.settingOwnership('Pool size')).toHaveText('Automatic')
    await expect(drawStructure.settingSource('Pool size')).toHaveText(
      AUTOMATIC_POOL_SIZE_SOURCE,
    )
    // No box while the system owns it — a read-only row here is text, never a disabled
    // input (ADR-0015). It is also what makes the same assertion at the very end mean
    // something.
    await expect(drawStructure.settingInput('Pool size')).toHaveCount(0)

    // ----- 2. the director takes it, and types a different number ------------
    await drawStructure.settingAction('Pool size', 'Set myself').click()
    // Taking a setting changes the OWNER, not the number: the box is seeded with the `8`
    // the row was already showing, so the first click moves nothing.
    await expect(drawStructure.settingInput('Pool size')).toHaveValue(String(POOL_SIZE))
    await expect(drawStructure.settingOwnership('Pool size')).toHaveText('Yours')

    await drawStructure.settingInput('Pool size').fill(String(MANUAL_POOL_SIZE))

    // ----- 3. …and the rest of the draw moves with it, before the save -------
    // Asserted here as well as after the reload, so a reload that shows the wrong numbers
    // is a persistence failure rather than a derivation one.
    await expect(drawStructure.settingValue('Pool count')).toHaveText(
      String(DERIVED_POOL_COUNT),
    )
    await expect(drawStructure.previewEquation).toHaveText(MANUAL_EQUATION)

    await editor.saveChanges()

    // ----- 4. the SERVER holds the mode, not just the number -----------------
    const stored = await findEventByName(director, tournamentId, RR_KO_EVENT)
    expect(stored.draw_structure).not.toBeNull()
    expect(stored.draw_structure?.pool_size_mode).toBe('manual')
    expect(stored.draw_structure?.manual_pool_size).toBe(MANUAL_POOL_SIZE)
    // The setting below it was never touched, and a save that took ownership of every row
    // it rendered would be a save that quietly froze three numbers.
    expect(stored.draw_structure?.pool_count_mode).toBe('automatic')

    // ----- 5. reload, and read the whole tab back ----------------------------
    await detail.reload(tournamentId)
    await expect(detail.title).toContainText(name)
    const reopened = await detail.openEvent(RR_KO_EVENT)
    const reloaded = await reopened.openDrawStructure()
    await expect(reloaded.section).toBeVisible()

    // The number **and** its owner. A `16` under an `Automatic` badge is the bug this
    // spec exists to catch, so the badge is not an extra — it is the assertion.
    await expect(reloaded.settingInput('Pool size')).toHaveValue(String(MANUAL_POOL_SIZE))
    await expect(reloaded.settingOwnership('Pool size')).toHaveText('Yours')
    await expect(reloaded.settingSource('Pool size')).toHaveText(MANUAL_POOL_SIZE_SOURCE)

    // The derived consequences came back with it, rather than the tab re-deriving the
    // automatic split off the four pool rows the event still has.
    await expect(reloaded.settingValue('Pool count')).toHaveText(
      String(DERIVED_POOL_COUNT),
    )
    await expect(reloaded.settingOwnership('Pool count')).toHaveText('Automatic')
    await expect(reloaded.settingSource('Pool count')).toHaveText(
      DERIVED_POOL_COUNT_SOURCE,
    )
    await expect(reloaded.previewEquation).toHaveText(MANUAL_EQUATION)
    await expect(reloaded.previewPoolCards).toHaveCount(DERIVED_POOL_COUNT)
    for (const letter of ['A', 'B']) {
      const card = reloaded.previewPoolCard(letter)
      // One fact per assertion — the card's own text runs together (see the page object).
      await expect(card).toContainText(String(MANUAL_POOL_SIZE))
      await expect(card).toContainText(`top ${DERIVED_QUALIFIERS_ADVANCING} advance`)
      await expect(card).not.toContainText('Too small')
    }
    await expect(reloaded.previewKnockout).toContainText(
      `${MANUAL_BRACKET_SIZE}-player bracket`,
    )
    // 240, against the automatic draw's 112. The loudest number on the screen, and the
    // one no fixture chose.
    await expect(reloaded.previewKnockout).toContainText(
      `${MANUAL_POOL_MATCHES} pool matches`,
    )
    await expect(reloaded.previewVerdict).toHaveText('Ready to save')
    await expect(reloaded.previewBadge).toHaveText('Sound')

    // ----- 6. the other direction: giving the setting back sticks too --------
    await reloaded.settingAction('Pool size', 'Use automatic').click()
    await expect(reloaded.settingOwnership('Pool size')).toHaveText('Automatic')
    await expect(reloaded.settingValue('Pool size')).toHaveText(String(POOL_SIZE))
    await reopened.saveChanges()

    // The number is KEPT while its mode is automatic (ADR 20260808) — `Use automatic` is
    // the opposite of destructive. Nothing on screen can say this, because the point of it
    // is that the screen goes back to the derived number.
    const returned = await findEventByName(director, tournamentId, RR_KO_EVENT)
    expect(returned.draw_structure?.pool_size_mode).toBe('automatic')
    expect(returned.draw_structure?.manual_pool_size).toBe(MANUAL_POOL_SIZE)

    await detail.reload(tournamentId)
    await expect(detail.title).toContainText(name)
    const finalEditor = await detail.openEvent(RR_KO_EVENT)
    const handedBack = await finalEditor.openDrawStructure()
    await expect(handedBack.settingOwnership('Pool size')).toHaveText('Automatic')
    await expect(handedBack.settingValue('Pool size')).toHaveText(String(POOL_SIZE))
    // The discriminator that the MODE came back, not merely the number: an automatic row
    // renders text, so a box here would mean the setting was still the director's and had
    // simply re-derived to the same `8`.
    await expect(handedBack.settingInput('Pool size')).toHaveCount(0)
    // …and the whole draw is the automatic one again: four pools of eight, off the four
    // pool rows the event has had all along.
    await expect(handedBack.previewEquation).toHaveText(EQUATION)
    await expect(handedBack.previewPoolCards).toHaveCount(POOL_COUNT)
  })

  /**
   * **The bug #1320 opens with, refused by name and at the right moment.**
   *
   * A real director configured one pool and one qualifier per pool. One player reaches the
   * bracket, so the draw could not be cut — and the two things that were wrong with that
   * are the two halves this test asserts:
   *
   * 1. **When.** The refusal arrived hours later, at the cut, against a configuration the
   *    app had cheerfully saved. It now arrives as the configuration is saved: the Save
   *    button is unavailable and says why, and the API refuses the same body.
   * 2. **What.** The message named the wrong cause. It now names the real one — the
   *    knockout having one player — in the derivation's own words.
   *
   * ## Why the qualifier count has to be the DIRECTOR'S
   *
   * An automatic count can no longer reach this state. It aims at an eight-player knockout
   * and stops at the smallest pool (`app/draw_structure.py`, and its TypeScript twin), so
   * across one pool of 32 it derives 8 and the draw is sound. That clamp is deliberate: a
   * number the system chooses for itself must be one it will accept, or a capped event
   * derives its own refusal and cannot be saved at all. A count the director **typed**
   * stands exactly as typed and is still refused when it cannot be played — their number,
   * their refusal — which is the only route to the configuration #1320 reported.
   *
   * So the spec reads the automatic 8 first, then takes the setting and types the 1. The
   * first reading is not scenery: it is what makes the refusal a consequence of the
   * director's number rather than of the seed.
   *
   * ## What only this suite can say
   *
   * That the **client gate and the server guard agree**. They are two independent
   * implementations of one rule (ADR
   * 20260808-draw-structure-derivation-runs-on-both-sides-and-shares-its-vectors) — the
   * client's so the tab never lags a keystroke, the server's because `ios/` and the MCP
   * server write events too and a rule enforced only in React is not enforced. The vector
   * tables pin the arithmetic on both sides; nothing but a composed stack can show one
   * browser being refused and the real API refusing the same body for the same cause.
   *
   * The API half is deliberately a **raw request**, not a second browser: what is being
   * asked is whether the server refuses a body the button would not send, so the body has
   * to come from somewhere other than the button.
   *
   * ## …and that the way out works
   *
   * A refusal that only says no is a dead end (ADR-0015). So the last third of the test
   * presses the offered fix and saves for real, and reads the result back off the server —
   * against a seeded K of **three**, so `2` on the way out is a number that was written
   * rather than one that was already there.
   */
  test('a director who takes one pool and one qualifier is told the knockout would have one player', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    // One pool row, and a stored K that is none of the numbers this test asserts.
    const { director, tournamentId, eventId, name } = await seedTwoStageTournament(
      page,
      { pools: SINGLE_POOL, qualifiersPerPool: SEEDED_LONE_POOL_QUALIFIERS },
    )

    const detail = await TournamentDetailPage.navigateTo(page, tournamentId)
    // The long timeout is the composed web-client's first compile of this route, not the
    // app — see the same wait in the two specs above.
    await expect(detail.title).toContainText(name, { timeout: 60_000 })

    const editor = await detail.openEvent(RR_KO_EVENT)
    const drawStructure = await editor.openDrawStructure()
    await expect(drawStructure.section).toBeVisible()

    // ----- 1. one pool, and an AUTOMATIC count that is deliberately playable -
    // The control the whole test rests on. If the tab arrived already refusing, every
    // assertion below would be about the seed rather than about what the director did.
    await expect(drawStructure.previewPoolCards).toHaveCount(1)
    await expect(drawStructure.previewPoolCard('A')).toContainText(
      String(LONE_POOL_SIZE),
    )
    await expect(drawStructure.settingValue('Qualifiers per pool')).toHaveText(
      String(AUTOMATIC_LONE_POOL_QUALIFIERS),
    )
    await expect(drawStructure.settingOwnership('Qualifiers per pool')).toHaveText(
      'Automatic',
    )
    await expect(drawStructure.previewVerdict).toHaveText('Ready to save')
    // No notice at all, which is a stronger statement than a green verdict: the panel is
    // absent when the numbers are sound, so its later appearance is a change of state.
    await expect(drawStructure.issue).toHaveCount(0)
    await expect(editor.saveChangesButton).toBeEnabled()

    // ----- 2. the director takes the count and types the one --------------
    await drawStructure.setManually('Qualifiers per pool', REFUSED_QUALIFIERS)
    // Their number, kept exactly as typed — not clamped back up to a playable 8, which is
    // the silent reshaping ADR 20260808 forbids and the reason this state is reachable.
    await expect(drawStructure.settingOwnership('Qualifiers per pool')).toHaveText(
      'Yours',
    )

    // ----- 3. THE ASSERTION: the refusal names the REAL cause -------------
    await expect(drawStructure.issue).toBeVisible()
    // An `alert`, not a `status`: this one reports a blocked act, so it interrupts rather
    // than waiting to be reached.
    await expect(drawStructure.issue).toHaveRole('alert')
    await expect(drawStructure.issue).toContainText(CANT_SAVE)
    // The one line this chore exists for. Exact, because every other reading in this
    // section is equally true of the three other things the app could have blamed.
    await expect(drawStructure.issueTitle).toHaveText(ONE_PLAYER_KNOCKOUT_TITLE)
    await expect(drawStructure.issueBody).toHaveText(ONE_PLAYER_KNOCKOUT_BODY)
    // …and the negative half, stated out loud rather than left to the exactness above.
    // Both strings are the panel's OWN pool-case copy — its title and its body — so both
    // are reachable and both would really fire. Thirty-two players in one pool is a fine
    // pool: nothing here is a pool-count problem, and the card below says so too.
    await expect(drawStructure.issue).not.toContainText('Pool A would have')
    await expect(drawStructure.issue).not.toContainText(
      'Use fewer pools or raise the player limit',
    )
    await expect(drawStructure.previewPoolCard('A')).not.toContainText('Too small')

    // The preview agrees, in its own words — read together, because a `Sound` badge over
    // a refusal panel would be worse than either alone.
    await expect(drawStructure.previewVerdict).toHaveText(IMPOSSIBLE_VERDICT)
    await expect(drawStructure.previewBadge).toHaveText(IMPOSSIBLE_BADGE)
    // The bracket the numbers actually describe: one player, and the empty half of the
    // smallest drawable bracket beside them.
    await expect(drawStructure.previewKnockout).toContainText('1-player bracket')
    await expect(drawStructure.previewKnockout).toContainText('1 first-round bye')

    // ----- 4. the save is UNAVAILABLE, and says why -----------------------
    // Visible and disabled under its refusing name — never `Save changes` at count zero,
    // which is also true of a sheet that saved and closed.
    await expect(editor.blockedSaveButton).toBeVisible()
    await expect(editor.blockedSaveButton).toBeDisabled()
    await expect(editor.saveBlockedReason).toHaveText(SAVE_BLOCKED_REASON)

    // ----- 5. and the SERVER refuses the same body, for the same cause -----
    // The other implementation of the one rule. Sent raw, because the point is that the
    // refusal does not depend on the button: `ios/` and the MCP server write events too.
    const refused = await patchEventDrawRaw(director, tournamentId, eventId, {
      drawType: 'rr-then-ko',
      qualifiersPerPool: REFUSED_QUALIFIERS,
      // Without this the count is automatic, the server clamps it to a playable 8, and
      // the request is accepted — the same reason the browser had to take the setting.
      drawStructure: { qualifiers_mode: 'manual' },
    })
    expect(refused.status()).toBe(422)
    const [problem] = await validationDetails(refused)
    // The API's sentence is its own — longer, because it carries the way out inside the
    // text where the panel has a button — but it names the same cause.
    expect(problem.msg).toBe(SERVER_ONE_PLAYER_KNOCKOUT_REFUSAL)
    // Pointed at the draw structure as a whole, which is the only honest single answer:
    // the qualifier count and the pool count are as much to blame as each other.
    expect(problem.loc).toEqual(['body', 'draw_structure'])
    // A refusal writes nothing. The event still holds the K it was seeded with, so the
    // 422 above is a rejected request rather than a rejected response to a landed write.
    const untouched = await findEventByName(director, tournamentId, RR_KO_EVENT)
    expect(untouched.qualifiers_per_pool).toBe(SEEDED_LONE_POOL_QUALIFIERS)

    // ----- 6. the way out is offered, and it works ------------------------
    // One fix, and only one: a knockout of one is reachable from exactly one pool taking
    // exactly one qualifier, so taking two is the whole of the answer.
    await expect(drawStructure.issueFixLabels).toHaveText([OFFERED_FIX])
    await expect(drawStructure.issueFixDetail(OFFERED_FIX)).toHaveText(
      OFFERED_FIX_DETAIL,
    )
    await drawStructure.applyFix(OFFERED_FIX).click()

    // The notice is gone — not replaced by a different one, which is what a fix that
    // traded one impossible competition for another would leave behind.
    await expect(drawStructure.issue).toHaveCount(0)
    await expect(drawStructure.previewVerdict).toHaveText('Ready to save')
    await expect(drawStructure.previewBadge).toHaveText('Sound')
    await expect(drawStructure.previewKnockout).toContainText('2-player bracket')
    await expect(drawStructure.previewKnockout).toContainText('No first-round byes')
    // The fix takes the setting as well as setting the number: left automatic, the
    // derivation would aim at eight again and hand the director's 2 straight back.
    await expect(drawStructure.settingInput('Qualifiers per pool')).toHaveValue(
      String(FIXED_QUALIFIERS),
    )
    await expect(drawStructure.settingOwnership('Qualifiers per pool')).toHaveText(
      'Yours',
    )

    // ----- 7. …and the editor will save it --------------------------------
    await expect(editor.blockedSaveButton).toHaveCount(0)
    await editor.saveChanges()

    // Read back off the server, against a seed of three: this `2` was written by the
    // fix, and the mode came with it.
    const saved = await findEventByName(director, tournamentId, RR_KO_EVENT)
    expect(saved.qualifiers_per_pool).toBe(FIXED_QUALIFIERS)
    expect(saved.draw_structure?.qualifiers_mode).toBe('manual')
  })
})
