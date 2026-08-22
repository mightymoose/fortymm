import { test, expect } from '@playwright/test'
import { faker } from '@faker-js/faker'

import { TournamentDetailPage } from '../page-objects/tournament-detail.page'
import { guestFromContext } from '../support/match-api'
import { grantBetaTester } from '../support/rbac-grant'
import {
  getEventGroups,
  getEventReservations,
  getScheduleDetail,
  groupLabel,
  seedEntrants,
  seedTournament,
  transitionTournament,
  type ReservationSpec,
  type TableSpec,
} from '../support/tournament-api'

const EVENT_NAME = 'Open Singles'

/** **Ten** reservations — the number that reproduced the bug, and still the number that
 * gives this spec its teeth. When a group's id was a client-minted string the collision
 * needed a two-digit number (`g-10-` sorts between `g-1-` and `g-2-`, so ten groups
 * ordered by id read 1, 10, 2, 3 … 9). Ids are server-minted uuids now — both the
 * reservation's and the group's the server mints for it in lockstep — so the wrong order
 * is no longer *that* order — it is an arbitrary one — and what ten buys is that an
 * arbitrary order is overwhelmingly unlikely to be the right one (one permutation in
 * `10!`), which the guard below checks rather than assumes. */
const RESERVATION_COUNT = 10

/** Two entrants per group — the round-robin cut refuses a group of fewer than two
 * (`_snake`: "a lone entrant has nobody to play"), so this is the floor. Twenty guests
 * is already the expensive part of this spec; a third per group would buy no new fact
 * about ordering. */
const ENTRANTS_PER_GROUP = 2
const ENTRANT_COUNT = RESERVATION_COUNT * ENTRANTS_PER_GROUP

/** Ten tables, one per reservation: ten reservations sharing one table is a
 * double-booking the editor warns about, and this spec's subject is the order, not the
 * warning. */
const TABLES: ReadonlyArray<TableSpec> = Array.from(
  { length: RESERVATION_COUNT },
  (_, i) => ({ label: `Table ${i + 1}`, court: 'A' }),
)

/**
 * The ten reservations **in the director's order**, `Reservation 1` … `Reservation 10`,
 * carrying **no ids** — the server mints those (ADR 20260801), so the list's order is
 * the only thing about order the payload can say at all.
 *
 * The names are deliberately at odds with the reservations' own lexicographic order
 * (`Reservation 10` sorts between `Reservation 1` and `Reservation 2`) — a leftover of
 * the seed that first reproduced this bug, kept because it is still a fine way to name
 * ten things without implying an order a reader might mistake for the one under test.
 * The order that actually matters here is the **group** order the server mints in
 * lockstep with these, checked below.
 */
const RESERVATIONS: ReadonlyArray<ReservationSpec> = Array.from(
  { length: RESERVATION_COUNT },
  (_, i) => ({
    name: `Reservation ${i + 1}`,
    tableLabels: [`Table ${i + 1}`],
  }),
)

/** What the draw must read, top to bottom: `Group A`, `Group B`, … `Group J` — the
 * computed label of the group at position 0, 1, … 9. A group carries no name of its
 * own (ADR 20260808), so this is the label the render derives from `position`, never a
 * director-typed string. */
const GROUP_LABELS_BY_POSITION = Array.from({ length: RESERVATION_COUNT }, (_, i) =>
  groupLabel(i),
)

/** The seeded groups' ids sorted by **codepoint** — the wrong order, and the shape the
 * server would produce if it ordered groups (or the reservations they map from) by id
 * rather than by an explicit `position`.
 *
 * Computed from the ids the server minted rather than declared as a constant, because
 * the ids are not this spec's to choose: a uuid's sort order is not knowable until the
 * row exists. Compared against, never asserted on — it is how the spec proves its own
 * fixture is capable of failing. (Plain `<`, not `localeCompare`: the latter collates by
 * locale rules and would quietly stop being a codepoint sort.) */
function sortedByCodepoint(ids: ReadonlyArray<string>): string[] {
  return [...ids].sort((a, b) => (a < b ? -1 : 1))
}

/**
 * Which entrants the snake deals into each group, by **registration index**.
 *
 * Twenty entrants across ten groups is one pass forward and one back (`_snake`): group
 * `i` takes registration `i` on the way out and registration `19 − i` on the way home.
 * So the group at position 0 (`Group A`) holds the 1st and 20th to register, the group
 * at position 1 (`Group B`) the 2nd and 19th, and so on.
 *
 * This is the half of the ordering that a heading assertion cannot see. The deal seeds
 * against `DrawConfig.group_ids`, so a stack that ordered those by id would deal the 2nd
 * registration into whichever group happened to land at position 1 by id-sort — a
 * membership mismatch a heading-only assertion could not catch.
 */
const dealtTo = (groupIndex: number): [number, number] => [
  groupIndex,
  ENTRANT_COUNT - 1 - groupIndex,
]

/**
 * **A ten-reservation event's draw reads Group A … Group J, through the whole composed
 * stack** (#1226, ADR 20260801 "reservations carry an explicit `position`", extended by
 * #1369's group/reservation split).
 *
 * A group's id was once a client-minted string — `g-1-…`, `g-2-…`, `g-10-…` — and
 * sorted as a string `g-10-` falls *between* `g-1-` and `g-2-`. Every site that ordered
 * groups by id therefore read a ten-group event as 1, 10, 2, 3 … 9: the read query that
 * returns the fixtures, the `ready_fixtures` grouping, and `DrawConfig.group_ids` — the
 * order the snake seeds against. A director with ten groups got a draw whose sections
 * were in one order and whose deal was in another.
 *
 * Ids are **server-minted uuids** now (ADR 20260801), and #1369 split the single id
 * space into two: a director-writable **reservation** (the venue booking) and a
 * server-owned **group** the server mints for it in lockstep (the competitive unit
 * everything about the draw — entrants, standings, a fixture's `group_id` — is keyed
 * by). Neither retires the claim — it generalises it. Ordering by id no longer produces
 * that one memorable wrong order; it produces an arbitrary one, which is a *worse* bug
 * and a less legible one. So the spec no longer writes the wrong answer down: it reads
 * the minted ids back, sorts them by codepoint, and checks that order really does
 * disagree with the positions before trusting anything below it.
 *
 * ## Why this claim needs the composed stack
 *
 * The api tests prove the server orders reservations (and mints groups) by position in
 * isolation; the web-client tests prove the renderer sorts correctly *given* groups that
 * carry one. Neither can see the two halves disagree — and the disagreement is the whole
 * bug, because `position` is a field the client is **forbidden** to send
 * (`ReservationWrite` is `extra="forbid"`; a create body carrying one is a 422). The
 * order the director typed survives only if the server derives it from the list, stores
 * it on the reservation AND the group it mints, serializes it, and the browser reads it
 * back the same way. This is the only suite where all four are the real thing.
 *
 * So the order is asserted at three places along that path, on one seeded event:
 *
 * 1. **The server stamped it** — on the reservations the director wrote, and in
 *    lockstep, on the groups it minted for them. Neither is a field a client could
 *    manufacture, since neither may be sent at all.
 * 2. **The wire carries it.** The detail's fixtures arrive grouped by their group's
 *    position, so the group ids' first appearances read exactly the ids the create
 *    response handed back, in that order — and not those ids in any other.
 * 3. **The browser renders it** — the ten group headings top to bottom, *and* the
 *    membership the deal put under each one. The second is the assertion that would red
 *    for a stack that ordered `DrawConfig.group_ids` by id, which the headings alone
 *    would not (a heading is a computed label, so it reads `Group A … Group J` in that
 *    order by construction regardless of which physical group landed at each position).
 *
 * ## Seed vs UI split
 *
 * Over the API (`support/tournament-api.ts`): the tournament, the ten-reservation event,
 * the publish, and twenty director-entered guests — twenty browser sign-ins to test a
 * *draw* would be twenty chances to fail for an unrelated reason, and director-entry has
 * no web UI at all. In the browser: **cutting the draw** and reading it, which is the
 * surface whose order is the subject.
 *
 * ## RBAC
 *
 * As in `tournament-lifecycle.spec.ts`: a minted user holds only the permissionless
 * default role, so `grantBetaTester` hands the director the tournament bundle over the
 * stack's own `postgres` container before any tournament write. Skipped against an
 * external `E2E_BASE_URL` stack, where the caller owns provisioning.
 */
test.describe('Tournament — ten-reservation draw order', () => {
  test('a ten-reservation draw reads Group A through Group J, and is dealt in that order', async ({
    page,
    baseURL,
  }) => {
    // Twenty minted guests, each a session + a typeahead + a director-entry, then a real
    // cut across ten groups — far past the 30s default.
    test.setTimeout(300_000)
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    // The director IS the browser's own session, so page navigations run as them.
    const director = await guestFromContext(page.request)
    grantBetaTester(director.username)

    // ----- seed: a tournament whose event has ten reservations, in order ------
    const name = `Groups ${faker.string.alphanumeric(8)}`
    const { tournamentId, eventId, reservations, groups } = await seedTournament(
      director,
      name,
      { tables: TABLES, reservations: RESERVATIONS },
    )
    const reservationIds = reservations.map((reservation) => reservation.id)
    const groupIds = groups.map((group) => group.id)

    // The fixture's own falsification guard, and it can only be asked once the ids
    // exist: if the minted ids happened to sort the way the positions do, every
    // assertion below would still pass and none of them would mean anything. One uuid
    // permutation in `10!` does, so this is a real (if rare) possibility and not a
    // formality — fail here, where the reason is legible, rather than three screens
    // away.
    expect(
      sortedByCodepoint(groupIds),
      'the minted group ids must sort DIFFERENTLY from their positions, or this spec cannot fail',
    ).not.toEqual(groupIds)

    // ----- 1. the SERVER stamped the order the director sent ------------------
    // Positions 0…9 against the reservations in the sent order, and — in lockstep —
    // against the groups the server minted for them. Neither a client could have
    // produced: `position` is not a field either write shape may send.
    const storedReservations = await getEventReservations(director, tournamentId, eventId)
    expect(storedReservations.map((reservation) => reservation.id)).toEqual(
      reservationIds,
    )
    expect(storedReservations.map((reservation) => reservation.position)).toEqual(
      RESERVATIONS.map((_, index) => index),
    )
    const storedGroups = await getEventGroups(director, tournamentId, eventId)
    expect(storedGroups.map((group) => group.id)).toEqual(groupIds)
    expect(storedGroups.map((group) => group.position)).toEqual(
      RESERVATIONS.map((_, index) => index),
    )
    // The 1:1, in the same order: the group at position `i` maps back to the
    // reservation at position `i`.
    expect(storedGroups.map((group) => group.reservation_id)).toEqual(reservationIds)

    // ----- publish, then fill the field --------------------------------------
    await transitionTournament(director, tournamentId, 'published')
    const entrants = await seedEntrants(
      director,
      baseURL!,
      tournamentId,
      eventId,
      ENTRANT_COUNT,
    )

    // ----- cut the draw, in the browser --------------------------------------
    const detail = await TournamentDetailPage.navigateTo(page, tournamentId)
    // `toContainText`, not `toHaveText`: the hero sets its own full stop after the name.
    // The long timeout is for the FIRST navigation only, and it is about the stack rather
    // than the app — the composed web-client is a Vite **dev** server, so the first
    // request for a route pays for transforming it on demand.
    await expect(detail.title).toContainText(name, { timeout: 60_000 })

    const drawPost = page.waitForResponse(
      (r) => r.url().endsWith('/draw') && r.request().method() === 'POST',
    )
    await detail.generateDrawButton(EVENT_NAME).click()
    const drawResponse = await drawPost
    expect(
      drawResponse.status(),
      `cutting the draw was refused: ${await drawResponse.text()}`,
    ).toBe(201)

    // ----- 3. the BROWSER renders the ten groups in position order ------------
    // One statement, and it pins both the count and the order: ten headings reading
    // Group A … Group J, top to bottom. This alone cannot distinguish a stack that
    // ordered groups by id from one that ordered by position — a computed label reads
    // in alphabet order either way — which is exactly why the membership check below
    // is the one that matters.
    await expect(detail.groupDrawHeadings(eventId)).toHaveText(GROUP_LABELS_BY_POSITION)

    // ----- …and the DEAL followed the same order -----------------------------
    // The headings alone cannot catch a mis-ordered deal (see above): the snake seeds
    // against the event's group order, so a stack ordering that by id would deal the
    // 2nd registration into whichever group id-sort put at position 1, and it would
    // still render under a label reading "Group B" — the label is position-derived, not
    // a check on which *physical* group holds that position. Membership is derived from
    // each group's own fixtures (ADR-0786), so this also says the fixtures were drawn
    // into the right groups.
    for (const [index, label] of GROUP_LABELS_BY_POSITION.entries()) {
      const [first, second] = dealtTo(index)
      await expect(
        detail.groupEntrants(eventId, label),
        `${label} holds the wrong entrants — the draw was dealt in the wrong group order`,
      ).toHaveText([entrants[first].username, entrants[second].username])
    }

    // ----- 2. and the WIRE carried that order to get here ---------------------
    // Read last, of the draw the browser just cut: the detail's fixtures come back
    // ordered by their group's position, so the group ids in first-appearance order are
    // the server's own statement of the event's group order — the one the page above
    // rendered.
    const schedule = await getScheduleDetail(director, tournamentId)
    const fixtures = schedule.events.find((e) => e.id === eventId)?.fixtures ?? []
    expect(fixtures).toHaveLength(RESERVATION_COUNT)
    const groupIdsOnTheWire = [
      ...new Set(
        fixtures.flatMap((fixture) =>
          fixture.group_id === null ? [] : [fixture.group_id],
        ),
      ),
    ]
    expect(groupIdsOnTheWire).toEqual(groupIds)

    await Promise.all(entrants.map((entrant) => entrant.ctx.dispose()))
  })
})
