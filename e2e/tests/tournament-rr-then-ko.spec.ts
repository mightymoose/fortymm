import { test, expect } from '@playwright/test'
import { faker } from '@faker-js/faker'

import { TournamentDetailPage } from '../page-objects/tournament-detail.page'
import { guestFromContext } from '../support/match-api'
import { grantBetaTester } from '../support/rbac-grant'
import {
  createTournament,
  findEventByName,
  getEventGroups,
  getEventReservations,
  getScheduleDetail,
  groupLabel,
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

/** `P` — three reservations, which is the smallest number at which the format's
 * cross-group seeding rule has anything to say (with one group the guarantee is waived,
 * with two it is nearly free).
 *
 * ⚠️ The reservation count no longer DETERMINES the group count (#1387): the server
 * materializes `ceil(field / 5)` group rows on every event write and maps the group at
 * position `p` onto reservation `p % RESERVATION_COUNT` — groups and reservations are no
 * longer minted one-per-one in lockstep. `MAX_PLAYERS` below is chosen so the derived
 * `GROUP_COUNT` comes out equal to this number anyway, which is what keeps a plain 1:1
 * reading true on the page without asserting a rule the server no longer runs. */
const RESERVATION_COUNT = 3
/** `K` — the qualifiers per group. The number this whole spec exists to get onto the
 * wire: an `rr-then-ko` create body without it is a **422** at the request boundary. */
const QUALIFIERS_PER_GROUP = 2
/** The event's player limit (`max_players`), set through the editor before the create.
 * The server materializes `ceil(field / 5)` group rows on every event write using this
 * cap as the field (#1387) — so THIS number, not `RESERVATION_COUNT`, is what decides
 * `GROUP_COUNT` below. Chosen equal to `ENTRANT_COUNT` so the cut's re-derivation off the
 * real registered field (also `ceil(entrants / 5)`) agrees with the create's, and the
 * draw is never re-materialized between create and cut. */
const MAX_PLAYERS = 12
/** `N` — twelve entrants, dealt four to a group. Enough to satisfy the cut's two
 * entrant-dependent refusals (`K ≤ ⌊N/P⌋` = 4, and `P × K ≥ 2`) with room to spare, and
 * enough that each group is a real round-robin rather than a single pairing. Equal to
 * `MAX_PLAYERS`, so the field the create materializes groups against is the field that
 * actually registers. */
const ENTRANT_COUNT = 12

/** The names the editor's reservation section mints, in the order it adds them — the
 * director's order, and therefore the `position` order the server stamps on the
 * reservations (the groups get their own `position`, derived from the player limit rather
 * than from these rows — #1387). Written down here because it is what the
 * reservation-facing assertions below compare against; the *rendered* group order below
 * is a computed label, not these names. */
const RESERVATION_NAMES = ['Reservation A', 'Reservation B', 'Reservation C']

/** `ceil(MAX_PLAYERS / 5)` — the group count the server materializes for this event
 * (#1387), spelled out as arithmetic rather than hardcoded so the "3" next to it is
 * legible. It comes out equal to `RESERVATION_COUNT`: the server maps the group at
 * position `p` onto reservation `p % RESERVATION_COUNT`, and with the two counts equal
 * that map is the identity (0→0, 1→1, 2→2) — which is why the reservation-to-group
 * assertions below still read as a plain 1:1, even though the rule behind them is not
 * one any more. */
const GROUP_COUNT = Math.ceil(MAX_PLAYERS / 5)

/** What the draw renders, top to bottom: `Group A`, `Group B`, `Group C` — the computed
 * label of the group at position 0, 1, 2. A group carries no name of its own (ADR
 * 20260808), so these are derived, never typed by the director. */
const GROUP_LABELS = Array.from({ length: GROUP_COUNT }, (_, i) => groupLabel(i))

/** `B` — the bracket the cut must derive: the smallest power of two that holds the
 * `P × K` = 6 qualifiers. **Eight, not sixteen** — the bracket is sized from the
 * qualifier count, never from the entrant count (ADR 20260727: "derived, never
 * configured"), so a bracket with a fourth round would mean the server had sized it off
 * `N` and the two numbers had been allowed to contradict each other. */
const BRACKET_ROUNDS = 3
/** Six qualifiers into eight slots is two byes, and **a bye is the ABSENCE of a
 * fixture** (ADR-0786) — so round one holds two fixtures, not four. */
const ROUND_ONE_FIXTURES = 2

/** How many matches each stage is: three groups of four is `3 × C(4,2)` = **eighteen**,
 * and an eight-slot bracket holding six qualifiers is 2 + 2 + 1 = **five** (the two byes
 * cost no fixture — unchanged, since the bracket is sized from `P × K`, never from the
 * field). Asserted against what `playEvent` actually decided, so a stage that quietly
 * materialized fewer matches than it owes is a red here — the "N passed against N
 * collected" check, one layer down. */
const GROUP_MATCHES = 18
const KNOCKOUT_MATCHES = 5

/**
 * **Who the snake deals into each group**, by registration index (`_snake`, ADR-0786):
 * twelve entrants across three groups is one pass out, one back, one out, one back again
 * — so the group at position 0 (`Group A`) takes registrations 0, 5, 6 and 11; position 1
 * (`Group B`) 1, 4, 7 and 10; position 2 (`Group C`) 2, 3, 8 and 9.
 *
 * Written down rather than read back off the draw, because the qualifier set below is
 * *derived* from it: who advances is "the top `K` of each group", and that is only a
 * statement a test can make in advance if it knows who is in each group. Asserting it on
 * the page is a bonus — the deal following the group order is `tournament-group-order`'s
 * subject at six groups, and this is not a second copy of that proof.
 */
const GROUP_MEMBERS: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 5, 6, 11],
  [1, 4, 7, 10],
  [2, 3, 8, 9],
]

/** The six who **qualify**, by registration index, and the six who do not.
 *
 * `playEvent`'s winner rule is "the earlier-registered entrant wins", so a group's
 * finishing order is its members in registration order and its qualifiers are the first
 * `K` of them. Flattened out of `GROUP_MEMBERS`, never retyped: a hand-written list could
 * drift from the deal it is supposed to follow, and would then be asserting a coincidence.
 */
const QUALIFIERS = GROUP_MEMBERS.flatMap((members) =>
  members.slice(0, QUALIFIERS_PER_GROUP),
)
const ELIMINATED = GROUP_MEMBERS.flatMap((members) =>
  members.slice(QUALIFIERS_PER_GROUP),
)

/** A uuid — what both a reservation id and a group id are, real rows each with a
 * `gen_random_uuid()` primary key (ADR 20260801). Asserted on the seed so that "these
 * ids are the server's" is established before the spec starts leaning on them. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Three tables, one per reservation, so the tournament has a venue catalogue of a
 * realistic shape. The editor's reservation section books none of them (a draw is cut
 * without regard to tables — placement is the scheduler's job), so they are scenery
 * here, not scaffolding. */
const TABLES: ReadonlyArray<TableSpec> = [
  { label: 'Table 1', court: 'A' },
  { label: 'Table 2', court: 'B' },
  { label: 'Table 3', court: 'C' },
]

/**
 * **Round-robin then knockout, through the whole composed stack** (#1227, ADR
 * "rr-then-ko cuts both stages upfront and seeds qualifiers rematch-free"; #1226, ADR
 * 20260801 "a reservation belongs to its event"; #1369, "the wire and both clients say
 * group and reservation").
 *
 * A director creates a tournament, authors an `rr-then-ko` event **in the browser** with
 * a qualifiers-per-group count, a twelve-player limit and three reservations, publishes,
 * has twelve players entered, cuts the draw across three **server-materialized** groups
 * — `ceil(field / 5)` of them, #1387 — takes the tournament live, and the event is played
 * out to a champion — the group stage seating its six qualifiers into a bracket that was
 * cut before anyone played, and the bracket crowning one of them.
 *
 * ## Why this spec is the one that matters for this format
 *
 * Every other gate in this arc watched a *mock* answer. The MSW store, the web-client
 * Playwright suite and the dev server all accept whatever body the client composes, so
 * all three stayed green while the client shipped a draw type whose create body the real
 * API refused with a 422 — the client named `rr-then-ko` and sent no
 * `qualifiers_per_group`; the server's draw-settings union requires one on that arm and
 * on no other. Nothing that stubs the network can see that, because the disagreement is
 * *between* the two halves. So this spec drives the seam for real, twice over:
 *
 * 1. **The create.** The event is authored through the editor sheet, so the body on the
 *    wire is the one `drawSettingsToApi` builds — and the spec asserts the POST's
 *    status is **201**, not merely that something appeared. A 422 fails here, naming
 *    itself, rather than surfacing three steps later as a missing event.
 * 2. **The read-back.** The server is asked what it stored: `draw_type: rr-then-ko` and
 *    `qualifiers_per_group: 2`. A 201 alone would also be returned by a server that
 *    accepted the create and dropped K on the floor.
 *
 * ## And the bracket must exist at cut time
 *
 * The other half of that ADR is that **both stages are cut in one stroke**: `plan_initial`
 * emits the group fixtures *and* the whole bracket, every side of it TBD. That is not an
 * optimization — an `advance()` can only ever fill a side of an *existing* fixture
 * (`SideFill`), so a bracket that did not exist at the cut could never come into being
 * at all. Groups without a bracket is therefore a real product failure and not a
 * selector miss: the second stage would be unreachable for the life of the event.
 *
 * ## The groups are the SERVER's now, and the draw is dealt across them in ITS order
 *
 * A group used to be one client-minted string inside a JSONB column, doing double duty
 * as a venue booking too; #1369 split it into a director-writable **reservation** row and
 * a server-owned **group** row. **#1387 changes what mints the group row**: it is no
 * longer one group per reservation. The server materializes `ceil(field / 5)` group rows
 * on every event write (`field` being the event's player limit, or 16 uncapped), and maps
 * the group at position `p` onto reservation `p % RESERVATION_COUNT` — so a group and a
 * reservation are still each a real row with its own `gen_random_uuid()` primary key and
 * an explicit `position` (ADR 20260801, extended), but they are minted by two different
 * rules, not one lockstep pair. This spec's `MAX_PLAYERS` happens to make the two counts
 * agree (both 3), which is what lets the assertions below still read as a plain 1:1.
 * Every claim this spec makes about the group stage has to be keyed on ids the *server*
 * chose, and the order has to be the one the director typed rather than any order those
 * ids happen to sort in. Three readings say so, at three different depths:
 *
 * * **stored** — the three reservations read back off the create response are uuids at
 *   positions 0, 1, 2, named `Reservation A`, `Reservation B`, `Reservation C` in the
 *   order the editor added them, and the three groups the server derived from the player
 *   limit read back at the same positions, each mapped onto its reservation by `position
 *   % RESERVATION_COUNT`;
 * * **on the wire** — the detail's fixtures come back grouped by group in position
 *   order, so the group ids' first appearances read as those three ids, in that order;
 * * **on the page** — each group section is keyed by its uuid, the headings read
 *   `Group A`, `Group B`, `Group C` top to bottom, and the entrants under each are the
 *   ones the snake dealt there.
 *
 * ## …and the qualifiers reach the bracket
 *
 * The claim no unit test makes. The api tests prove `advance()` seats a finished group's
 * qualifiers into their predetermined slots; the web-client tests prove a bracket renders
 * the sides it is handed. Only here does a real group, decided by real matches through
 * the real completion hook, put a real name into a real bracket slot — so the spec plays
 * the group stage out and then asserts the bracket names **exactly** the six who
 * qualified and **none** of the six who did not, on a bracket that named nobody at all
 * an hour before. Then the knockout is played too, and the card crowns the champion the
 * bracket produced.
 *
 * ## Seed vs UI split
 *
 * Inert scaffolding over the API (`support/tournament-api.ts`, `support/tournament-play.ts`):
 * the tournament shell, its table catalogue, the twelve entrants — director-entry, which
 * has no web UI, and twelve browser sign-ins to test a *draw* would be twelve chances to
 * fail for an unrelated reason — and the twenty-three matches, which
 * `tournament-lifecycle.spec.ts` already drives through the score-entry UI once,
 * deliberately. Load-bearing steps in the browser: authoring the event and its draw
 * configuration (including the player limit the group count is derived from), publishing,
 * cutting the draw, going live, and every reading of the draw, the bracket and the
 * champion.
 *
 * ## RBAC
 *
 * As in `tournament-lifecycle.spec.ts`: a minted user holds only the permissionless
 * default role, so `grantBetaTester` hands the director the tournament bundle over the
 * stack's own `postgres` container before any tournament write. Skipped against an
 * external `E2E_BASE_URL` stack, where the caller owns provisioning.
 */
test.describe('Tournament — rr-then-ko draw', () => {
  test('a director cuts an rr-then-ko draw across three groups, and it is played to a champion', async ({
    page,
    baseURL,
  }) => {
    // Twelve minted guests, twelve director-entries, a real draw cut and twenty-three real
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
    // The qualifier box exists ONLY for this draw type — it is absent, not disabled,
    // for a format with no knockout stage to qualify for. So its appearance is the
    // proof the picker's choice reached the form, before anything is submitted.
    await expect(editor.qualifiersInput).toBeVisible()
    await editor.setQualifiersPerGroup(QUALIFIERS_PER_GROUP)
    // The field the server derives the group count from (#1387) — set on the Basics tab,
    // BEFORE `addReservations` switches the sheet to the Reservations tab.
    await editor.setPlayerLimit(MAX_PLAYERS)
    await editor.addReservations(RESERVATION_COUNT)

    // THE 422 GATE. The create body is the client's own, and its status is asserted
    // directly: a body missing `qualifiers_per_group` is refused at the request
    // boundary, and this is the assertion that says so in those terms. It is also the
    // gate the reservation ids cross — the editor mints none, so a client that still did
    // would be refused here for `body.reservations[0].id` instead.
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
    expect(event.qualifiers_per_group).toBe(QUALIFIERS_PER_GROUP)
    const eventId = event.id

    // ----- …and three reservations the SERVER minted, in the order they were added, plus
    //       the three groups it DERIVED from the player limit (#1387) -----------
    // Positions 0, 1, 2 against the editor's own `Reservation A`, `Reservation B`,
    // `Reservation C`. The client sent neither an id nor a position
    // (`ReservationWrite` has a field for neither), so both columns here are the
    // server's own work — and the ids being uuids is what makes every "by group id"
    // assertion below a statement about the server's groups.
    const reservations = await getEventReservations(director, tournamentId, eventId)
    expect(reservations.map((reservation) => reservation.name)).toEqual(
      RESERVATION_NAMES,
    )
    expect(reservations.map((reservation) => reservation.position)).toEqual([0, 1, 2])
    for (const reservation of reservations) expect(reservation.id).toMatch(UUID)

    // `ceil(MAX_PLAYERS / 5)` = 3 group rows, at positions 0, 1, 2 — the same count as
    // `RESERVATION_COUNT`, so `position % RESERVATION_COUNT` is the identity and this
    // still reads as a plain 1:1 map onto the reservations above, even though the server
    // no longer mints one because of the other.
    const groups = await getEventGroups(director, tournamentId, eventId)
    expect(groups.map((group) => group.position)).toEqual([0, 1, 2])
    expect(groups.map((group) => group.reservation_id)).toEqual(
      reservations.map((reservation) => reservation.id),
    )
    for (const group of groups) expect(group.id).toMatch(UUID)

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
    // card lists eight chips and collapses the rest into "+4 more", so a list-item count
    // here would be eight for the wrong reason — the truncation, not the field.
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

    // ----- stage one: three groups, keyed and ordered by the server -----------
    await expect(detail.groupDraws(eventId)).toHaveCount(GROUP_COUNT)
    // Top to bottom in position order. One statement pinning both the count and the
    // order — a draw whose sections came back in any other order reds here. (What that
    // order is *derived from* — `position`, and never the group ids — is
    // `tournament-group-order.spec.ts`'s subject, at the six groups it takes to tell the
    // two apart reliably.)
    await expect(detail.groupDrawHeadings(eventId)).toHaveText(GROUP_LABELS)
    for (const [index, group] of groups.entries()) {
      // The section is keyed by the group's uuid, so this asks for the server's group by
      // the server's id and would find nothing if the page keyed its sections any other
      // way.
      await expect(detail.groupDraw(eventId, group.id)).toBeVisible()
      // Twelve entrants snake-dealt across three groups is four apiece — the group
      // membership is derived from the group's own fixtures (ADR-0786), so this is also
      // the statement that each group really got a round-robin of its own, and that the
      // deal followed the same group order the headings above are in.
      const label = GROUP_LABELS[index]
      await expect(
        detail.groupEntrants(eventId, label),
        `${label} holds the wrong entrants — the draw was dealt in the wrong group order`,
      ).toHaveText(GROUP_MEMBERS[index].map((i) => entrants[i].username))
    }

    // ----- …and the WIRE carried that order to get here -----------------------
    // The detail's fixtures come back ordered by their group's position, so the group
    // ids in first-appearance order are the server's own statement of the event's group
    // order — the one the page above rendered, read straight off the payload that fed
    // it.
    const schedule = await getScheduleDetail(director, tournamentId)
    const fixtures = schedule.events.find((e) => e.id === eventId)?.fixtures ?? []
    expect([
      ...new Set(
        fixtures.flatMap((fixture) =>
          fixture.group_id === null ? [] : [fixture.group_id],
        ),
      ),
    ]).toEqual(groups.map((group) => group.id))

    // ----- stage two: the bracket, present already, and entirely unknown -----
    await expect(detail.bracket(eventId)).toBeVisible()
    // Sized from the qualifiers (6 → 8 slots → 3 rounds), never from the entrants
    // (12 → 16 → 4 rounds). The absent fourth round is the load-bearing half.
    await expect(detail.bracketRound(eventId, BRACKET_ROUNDS)).toBeVisible()
    await expect(detail.bracketRound(eventId, BRACKET_ROUNDS + 1)).toHaveCount(0)
    // Two byes, so round one is two fixtures — a bye is an absent fixture, not a row.
    await expect(detail.bracketRound(eventId, 1).getByRole('listitem')).toHaveCount(
      ROUND_ONE_FIXTURES,
    )
    // The final exists and both its sides are unknown: nobody has played, so every
    // knockout side is TBD and the bracket names NO entrant yet. `SideFill` seats them
    // below, group by group, into slots that already exist.
    const final = detail.bracketRound(eventId, BRACKET_ROUNDS).getByRole('listitem')
    await expect(final).toHaveCount(1)
    await expect(final).toHaveText(/TBD\s*vs\s*TBD/)
    for (const entrant of entrants) {
      await expect(detail.bracket(eventId)).not.toContainText(entrant.username)
    }

    // ----- go live: the group fixtures become real matches -------------------
    await detail.startTournament()
    await expect(detail.endButton).toBeVisible()

    // ----- play the GROUP STAGE, and only it, over the API --------------------
    // Stopping here is the whole point of the `'groups'` stage: the moment worth looking
    // at — groups decided, qualifiers seated, nobody knocked out — does not exist if the
    // helper plays on. The earlier-registered entrant always wins, so each group's
    // qualifiers are exactly `GROUP_MEMBERS`' first two.
    expect(
      await playEvent(director, tournamentId, eventId, entrants, 'groups'),
      'the group stage must materialize one match per pairing',
    ).toBe(GROUP_MATCHES)

    // ----- the qualifiers are SEATED in the bracket that named nobody --------
    await detail.reload(tournamentId)
    for (const index of QUALIFIERS) {
      await expect(
        detail.bracket(eventId),
        `${entrants[index].username} qualified but is not in the bracket`,
      ).toContainText(entrants[index].username)
    }
    // The half that makes it an assertion about *seeding* rather than about names
    // appearing: the six who did not qualify are still absent, so the bracket was
    // filled from each group's top K and not from the group.
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
    // The two-stage callout, never the round-robin one: in this format leading a group
    // wins nothing, so the name here is the knockout FINAL's winner. Under the winner
    // rule that is the first entrant to register, who won every match they played.
    await expect(detail.twoStageChampion(eventId)).toBeVisible()
    await expect(detail.twoStageChampion(eventId)).toContainText(entrants[0].username)

    await Promise.all(entrants.map((entrant) => entrant.ctx.dispose()))
  })
})
