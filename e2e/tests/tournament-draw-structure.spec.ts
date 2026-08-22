import { test, expect } from '@playwright/test'
import { faker } from '@faker-js/faker'

import { TournamentDetailPage } from '../page-objects/tournament-detail.page'
import { guestFromContext } from '../support/match-api'
import { grantBetaTester } from '../support/rbac-grant'
import {
  addEvent,
  createTournament,
  findEventByName,
  type ReservationSpec,
} from '../support/tournament-api'

/** The two-stage event, and the handle every reading below finds it by. */
const RR_KO_EVENT = 'Two-stage Open'
/** The plain round-robin standing beside it — the control. Named so that neither event's
 * name is a substring of the other's, since both are addressed by name on one page. */
const ROUND_ROBIN_EVENT = 'One-stage Open'

/** The event's **cap**, which is the field the tab derives against (a capped event
 * previews against its cap; an uncapped one against a synthetic 16). Twenty because it
 * divides by the default group size of five exactly — so the uneven notice is absent
 * and any `4–5` on screen is a real failure. */
const FIELD_CAP = 20
/** The derived group count: `ceil(20 / 5)` under the default divisor of five (#1386).
 * NOT the reservation row count — the derivation stopped reading it. The four seeded
 * rows below deliberately match this number, so every numeric assertion is stable under
 * either rule and none of them discriminates the source. The one assertion that does is
 * `GROUP_COUNT_SOURCE`, verbatim: the old rule's sentence named the reservation rows,
 * and this one names the division. */
const GROUP_COUNT = 4
/** The four reservation rows, booking **no** tables — a draw is cut without regard to
 * tables, and an empty `table_ids` is what the editor's own reservation section sends.
 * Four tables shared four ways would be scenery this spec never looks at. */
const RESERVATIONS: ReadonlyArray<ReservationSpec> = ['A', 'B', 'C', 'D'].map(
  (letter) => ({
    name: `Reservation ${letter}`,
    tableLabels: [],
  }),
)

/** **K as the event STORES it** — required with no default on the server's `rr-then-ko`
 * arm, so the seed must send it or the create is a 422 naming the field.
 *
 * Since #1425 the tab reads THIS number: a stored K reaches the tab as `Yours`, and an
 * event whose director never typed one reads `Unset` rather than an invented
 * `Automatic` figure. It still agrees with the derived `ceil(8 / 4)` = 2 here, which is
 * what keeps every numeric assertion below stable across the two sources. */
const STORED_QUALIFIERS_PER_GROUP = 2

/** The qualifiers row under a stored K: the badge says who owns it, and the sentence is
 * the manual one (#1425). Verbatim, like every source line asserted here. */
const QUALIFIERS_OWNERSHIP = 'Yours'
const QUALIFIERS_SOURCE = 'You set this.'

/** What the derivation makes of a field of `20`, and the only numbers this spec asserts.
 * Worked from the derivation's own arithmetic (`data/draw-structure.ts`, and the
 * divergence note in `docs/designs/rr-then-ko-draw-structure`): `ceil(20 / 5)` = 4
 * groups, balanced to `5, 5, 5, 5`; the automatic qualifier count is `ceil(8 / 4)` = 2;
 * the bracket is `4 × 2` = 8, which is already a power of two and so takes no byes; and
 * the group stage plays `4 × C(5,2)` = 40 matches. */
const GROUP_SIZE = 5
const QUALIFIERS_ADVANCING = 2
const BRACKET_SIZE = 8
const GROUP_MATCHES = 40

/** The equation, whole. Safe to assert as one string — unlike the cards below it, every
 * literal in that line carries its own spaces (`textContent` inserts none of its own, so
 * a group card reads `Group A8playerstop 2 advance` and is stated one fact at a time). */
const EQUATION = `${FIELD_CAP} players ÷ ${GROUP_COUNT} groups = ${GROUP_SIZE} per group`

/** The source line under the Group count row, **verbatim**.
 *
 * Ours, not the reference's (#1386): the automatic count divides the field by the
 * default group size of five, and the sentence reports that division — the `÷` glyph
 * (U+00F7) is load-bearing, and the divisor is the default the director never typed.
 * The reference's reservation-count sentence is gone with the input it reported. */
const GROUP_COUNT_SOURCE = `${FIELD_CAP} players ÷ about 5 per group`

/** Where the preview field came from. `{n}-player cap` for a capped event — the honest
 * label an uncapped one gets instead is `preview-field.ts`'s deviation from the reference
 * and belongs to a different event than this one. */
const PREVIEW_BASIS = `${FIELD_CAP}-player cap`

/**
 * **The Draw structure tab, through the whole composed stack** (#1320).
 *
 * A director opens a round-robin-then-knockout event they have already saved, and reads
 * the draw their 20-player cap already implies under the default group size of five:
 * four groups of five, two out of each, an eight-player bracket with no byes, and 40
 * group matches to decide it.
 *
 * ## What only this suite can say
 *
 * The arithmetic is already proved. `data/draw-structure.test.ts` runs the derivation's
 * whole vector table against a Python twin, and the component tests render each part of
 * the tab from a fixture. Both stop at the same edge: they hand the derivation numbers
 * that a *test* chose.
 *
 * This spec hands it numbers the **server** chose. The cap is a `max_players` column,
 * and it reaches the tab only by being serialized onto `GET /v1/tournaments/{id}`,
 * parsed at the client's fetch boundary, and mapped into the editor's draft. Every step
 * of that is real here and mocked everywhere else — so `40 group matches` on this
 * screen is the statement that the real payload, decoded through the real fetch stack,
 * produces the derivation's number.
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
  test('a director reads the draw their player cap already implies, and only this format offers it', async ({
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
      qualifiersPerGroup: STORED_QUALIFIERS_PER_GROUP,
      maxPlayers: FIELD_CAP,
      reservations: RESERVATIONS,
    })
    // The control, and the reason it is on the SAME tournament: two events one click
    // apart is the sharpest form of "this format has the tab and that one does not".
    await addEvent(director, tournamentId, tables, {
      name: ROUND_ROBIN_EVENT,
      reservations: [{ name: 'Reservation A', tableLabels: [] }],
    })

    // ----- the SERVER holds what the tab is about to be derived from ---------
    // Read back before a browser is involved, so a wrong number on screen below can only
    // be the client's doing. A 201 alone would also come back from a server that stored
    // the event and dropped its cap or its reservations.
    const stored = await findEventByName(director, tournamentId, RR_KO_EVENT)
    expect(stored.draw_type).toBe('rr-then-ko')
    expect(stored.qualifiers_per_group).toBe(STORED_QUALIFIERS_PER_GROUP)

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

    // ----- four groups of eight, two out of each ------------------------------
    await expect(drawStructure.previewGroupCards).toHaveCount(GROUP_COUNT)
    for (const letter of ['A', 'B', 'C', 'D']) {
      const card = drawStructure.previewGroupCard(letter)
      // One fact per assertion: `textContent` puts no space between block elements, so
      // the card reads `Group A8playerstop 2 advance` as one string and a whole-card
      // `toHaveText` would be pinning that concatenation instead of the copy.
      await expect(card).toContainText(`${GROUP_SIZE}`)
      await expect(card).toContainText('players')
      await expect(card).toContainText(`top ${QUALIFIERS_ADVANCING} advance`)
      // The negative half: a group that cannot be played says so in words, and none of
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
    // `4 × C(5,2)`. The one number on this screen that no other surface states.
    await expect(drawStructure.previewKnockout).toContainText(
      `${GROUP_MATCHES} group matches`,
    )

    // ----- the verdict, which is the tab's one summary -----------------------
    // Read together, because the heading and the badge are one decision: a `Sound` badge
    // over `This draw can’t work yet` would be worse than either alone.
    await expect(drawStructure.previewVerdict).toHaveText('Ready to save')
    await expect(drawStructure.previewBadge).toHaveText('Sound')

    // ----- and the Group count row says where its number came from -----------
    // The row a director looks at to learn that nobody chose this: the value, the badge
    // that says the system owns it, and the sentence naming the division that produced
    // it. Addressed by the setting's name, which is the row's accessible name.
    await expect(drawStructure.settingValue('Group count')).toHaveText(
      String(GROUP_COUNT),
    )
    await expect(drawStructure.settingUnit('Group count')).toHaveText('groups')
    await expect(drawStructure.settingOwnership('Group count')).toHaveText('Automatic')
    await expect(drawStructure.settingSource('Group count')).toHaveText(
      GROUP_COUNT_SOURCE,
    )
    // The groups are even, so the size row reads one number and not a `{min}–{max}` range
    // — the fact that keeps the equation above from being an average.
    await expect(drawStructure.settingValue('Group size')).toHaveText(String(GROUP_SIZE))
    await expect(drawStructure.settingUnit('Group size')).toHaveText('players per group')

    // ----- the qualifiers row reads the STORED K, as the director's own (#1425) --------
    // The row that used to invent a number: since #1425 it shows what the event holds,
    // badged `Yours` with the manual sentence, not a derived figure under `Automatic`.
    await expect(
      drawStructure.settingOwnership('Qualifiers per group'),
    ).toHaveText(QUALIFIERS_OWNERSHIP)
    await expect(drawStructure.settingSource('Qualifiers per group')).toHaveText(
      QUALIFIERS_SOURCE,
    )

    // ----- the control: a plain round-robin is offered NO such tab -----------
    // Reloaded rather than closing the sheet: the editor is a modal, so its overlay
    // covers the second event's card until it is gone, and a fresh page is the shortest
    // way to be sure of that.
    await detail.reload(tournamentId)
    const plainEditor = await detail.openEvent(ROUND_ROBIN_EVENT)
    // FIRST that the sheet is open at all. Without this, a click that missed would leave
    // a page with no tabs on it, and "no Draw structure tab" would pass for free.
    await expect(plainEditor.tab('Basics')).toBeVisible()
    await expect(plainEditor.tab('Reservations')).toBeVisible()
    await expect(plainEditor.tab('Draw structure')).toHaveCount(0)
    // …and no panel left behind either: the trigger and its content are rendered
    // together, so a tab that vanished while its content stayed would be a blank fifth
    // section a director could still be sent to.
    await expect(plainEditor.drawStructure.section).toHaveCount(0)
  })
})
