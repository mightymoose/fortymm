import { test, expect } from '@playwright/test'
import { faker } from '@faker-js/faker'

import { TournamentDetailPage } from '../page-objects/tournament-detail.page'
import { guestFromContext } from '../support/match-api'
import { grantBetaTester } from '../support/rbac-grant'
import {
  getEventGroups,
  getEventReservations,
  getEventStages,
  getScheduleDetail,
  groupLabel,
  seedEntrants,
  seedTournament,
  transitionTournament,
  type ReservationSpec,
  type TableSpec,
} from '../support/tournament-api'

const EVENT_NAME = 'Open Singles'

/** The event's draw type (#1482): a non-`rr-then-ko` event may hold at most one
 * reservation now, refused at the request boundary with a 422 over the cap. This
 * spec's whole subject is many-reservation ordering, so it moved to the one draw type
 * the cap still lets hold many, rather than shrinking to one reservation and losing
 * the coverage. */
const DRAW_TYPE = 'rr-then-ko'

/** **Six** reservations. Under `rr-then-ko` the group count is no longer counted off
 * this list at all — `group_count_for` (api/app/tournament_reservations.py) derives it
 * from the FIELD instead (`ceil(field_size / 5)`, #1386), so six is a statement about
 * `ENTRANT_COUNT` below, not about this array's length: thirty entrants is the
 * smallest field that lands on six groups.
 *
 * Ids are server-minted uuids (ADR 20260801) — both the reservation's and the group the
 * server mints for it in lockstep — so a stack that ordered groups by id rather than
 * position would read an arbitrary wrong order, not a memorable one, which is why the
 * guard below reads the minted ids back and checks that codepoint order really does
 * disagree with position order rather than assuming it. One uuid permutation in `6!`
 * (720) would coincide with position order by chance; four reservations would put that
 * risk at one in 24 — a ~4% flake — so six is the smallest count that makes it
 * negligible. */
const RESERVATION_COUNT = 6

/** Five entrants per group — `rr-then-ko`'s own group size (`ceil(field / 5)`, #1386),
 * so a group under this draw type is never smaller than this by construction, and the
 * seed cannot make it smaller by asking for fewer entrants without also shrinking the
 * group count. Thirty guests is already the expensive part of this spec; a bigger
 * group would buy no new fact about ordering, only a slower run. */
const ENTRANTS_PER_GROUP = 5
const ENTRANT_COUNT = RESERVATION_COUNT * ENTRANTS_PER_GROUP

/** The event's `max_players` cap — the **preview** field `group_count_for` reads at
 * create time. Set to the same number as `ENTRANT_COUNT` deliberately: the cap and the
 * real registered field must agree on `ceil(field / 5) = 6`, or the cut below
 * re-materialises the groups at whatever count the real field implies (ADR 20260822),
 * and this spec's own group ids stop matching what the browser draws. */
const FIELD_CAP = ENTRANT_COUNT

/** **K** — how many finishers of each group reach the knockout stage, required with no
 * default on the `rr-then-ko` arm (a create/edit naming no value there is a 422 naming
 * the field). The value itself is inert to this spec's subject, which is group order,
 * not the bracket it feeds — any value the group size can support does. */
const QUALIFIERS_PER_GROUP = 2

/** Six tables, one per reservation: six reservations sharing one table is a
 * double-booking the editor warns about, and this spec's subject is the order, not the
 * warning. */
const TABLES: ReadonlyArray<TableSpec> = Array.from(
  { length: RESERVATION_COUNT },
  (_, i) => ({ label: `Table ${i + 1}`, court: 'A' }),
)

/**
 * The six reservations **in the director's order**, `Reservation 1` … `Reservation 6`,
 * carrying **no ids** — the server mints those (ADR 20260801), so the list's order is
 * the only thing about order the payload can say at all.
 *
 * Plain ascending names, and deliberately so this time: at six, the names' own
 * lexicographic order already agrees with the director's order (unlike the
 * ten-reservation seed this spec used to carry, where `Reservation 10` sorted between
 * `Reservation 1` and `Reservation 2` — a two-digit quirk six never reaches). The order
 * that actually matters here is the **group** order the server mints in lockstep with
 * these, checked below — the names are never asserted on for their own sort.
 */
const RESERVATIONS: ReadonlyArray<ReservationSpec> = Array.from(
  { length: RESERVATION_COUNT },
  (_, i) => ({
    name: `Reservation ${i + 1}`,
    tableLabels: [`Table ${i + 1}`],
  }),
)

/** What the draw must read, top to bottom: `Group A`, `Group B`, … `Group F` — the
 * computed label of the group at position 0, 1, … 5. A group carries no name of its
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

/** One group's fixture count under a round-robin group stage — `C(5, 2)`, every pair in
 * a group of five exactly once. `rr-then-ko` cuts the group stage AND the knockout
 * bracket in one stroke (ADR "rr-then-ko cuts both stages upfront"), so the event's
 * total fixture count also includes the bracket's — a number this spec does not restate
 * here, since deriving it honestly would mean re-deriving the bracket's own bye
 * arithmetic (`_bracket_size`, `_knockout_fixtures` in `api/app/draws.py`) for a fact
 * this spec's subject (group order) has no use for. What it asserts instead is the
 * group-stage fixture count alone — the fixtures whose `stage_id` names the event's
 * GROUP stage (position 0), never the knockout stage's (ADR 20260823, #1484: every
 * fixture of both stages now names a real, non-null `group_id`, so that column no
 * longer tells them apart). */
const GROUP_STAGE_FIXTURES_PER_GROUP = 10
const GROUP_STAGE_FIXTURE_COUNT = GROUP_STAGE_FIXTURES_PER_GROUP * RESERVATION_COUNT

/**
 * Which entrants the snake deals into each group, by **registration index**.
 *
 * Thirty entrants across six groups is five snake rows — out, back, out, back, out
 * (`_snake`: row `r`'s deal runs forward when `r` is even, backward when `r` is odd) —
 * so the group at position `i` takes registrations `i`, `11−i`, `12+i`, `23−i` and
 * `24+i`: the group at position 0 (`Group A`) holds the 1st, 12th, 13th, 24th and 25th
 * to register; the group at position 1 (`Group B`) the 2nd, 11th, 14th, 23rd and 26th;
 * and so on.
 *
 * This is the half of the ordering that a heading assertion cannot see. The deal seeds
 * against `DrawConfig.group_ids`, so a stack that ordered those by id would deal the 2nd
 * registration into whichever group happened to land at position 1 by id-sort — a
 * membership mismatch a heading-only assertion could not catch.
 */
const dealtTo = (groupIndex: number): number[] =>
  Array.from({ length: ENTRANTS_PER_GROUP }, (_, row) =>
    row % 2 === 0
      ? row * RESERVATION_COUNT + groupIndex
      : row * RESERVATION_COUNT + (RESERVATION_COUNT - 1 - groupIndex),
  )

/**
 * **A six-group `rr-then-ko` draw reads Group A through Group F, through the whole
 * composed stack** (#1226, ADR 20260801 "reservations carry an explicit `position`",
 * extended by #1369's group/reservation split, and moved onto `rr-then-ko` by #1482 —
 * see `DRAW_TYPE` above for why).
 *
 * A group's id was once a client-minted string — `g-1-…`, `g-2-…`, `g-10-…` — and
 * sorted as a string `g-10-` falls *between* `g-1-` and `g-2-`. Every site that ordered
 * groups by id therefore read a many-group event's groups out of order: the read query
 * that returns the fixtures, the `ready_fixtures` grouping, and `DrawConfig.group_ids` —
 * the order the snake seeds against. A director with several groups got a draw whose
 * sections were in one order and whose deal was in another.
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
 * ## Why `rr-then-ko`, and the arithmetic that comes with it
 *
 * Under `rr-then-ko` the group count is derived from the field (`ceil(field_size / 5)`,
 * #1386) rather than counted off the reservation list — `group_count_for`
 * (api/app/tournament_reservations.py) says so explicitly: "the reservation count plays
 * no part". So this spec's six reservations buy six groups only because the seed also
 * picks a field of thirty: `ceil(30 / 5) = 6`. That field is read **twice** — the
 * `max_players` cap at create time (the preview field), and the real registered count at
 * cut time — and the two must agree, or the cut re-materialises the groups at whatever
 * count the real field implies (ADR 20260822) and this spec's own reservation/group ids
 * stop matching what the browser draws. Both are seeded to exactly `ENTRANT_COUNT`.
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
 *    response handed back, in that order — and not those ids in any other. Knockout
 *    fixtures carry `group_id: null` and sort last (the query's own ordering), so they
 *    fall out of this reading for free.
 * 3. **The browser renders it** — the six group headings top to bottom, *and* the
 *    membership the deal put under each one. The second is the assertion that would red
 *    for a stack that ordered `DrawConfig.group_ids` by id, which the headings alone
 *    would not (a heading is a computed label, so it reads `Group A … Group F` in that
 *    order by construction regardless of which physical group landed at each position).
 *
 * ## Seed vs UI split
 *
 * Over the API (`support/tournament-api.ts`): the tournament, the six-reservation event,
 * the publish, and thirty director-entered guests — thirty browser sign-ins to test a
 * *draw* would be thirty chances to fail for an unrelated reason, and director-entry has
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
test.describe('Tournament — six-group rr-then-ko draw order', () => {
  test('a six-group draw reads Group A through Group F, and is dealt in that order', async ({
    page,
    baseURL,
  }) => {
    // Thirty minted guests, each a session + a typeahead + a director-entry, then a real
    // cut across six groups — far past the 30s default.
    test.setTimeout(300_000)
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    // The director IS the browser's own session, so page navigations run as them.
    const director = await guestFromContext(page.request)
    grantBetaTester(director.username)

    // ----- seed: a tournament whose event has six reservations, in order -----
    const name = `Groups ${faker.string.alphanumeric(8)}`
    const { tournamentId, eventId, reservations, groups } = await seedTournament(
      director,
      name,
      {
        tables: TABLES,
        reservations: RESERVATIONS,
        drawType: DRAW_TYPE,
        qualifiersPerGroup: QUALIFIERS_PER_GROUP,
        maxPlayers: FIELD_CAP,
      },
    )
    const reservationIds = reservations.map((reservation) => reservation.id)
    // `groups` carries EVERY stage's rows now (ADR 20260823, #1484) — this
    // `rr-then-ko` event's six group-stage groups AND its knockout stage's own one,
    // mixed together. Scoped to the group stage (position 0) before this spec's
    // subject — group ORDER — is asked about it; the knockout stage's single group
    // has no order of its own to be wrong about.
    const stages = await getEventStages(director, tournamentId, eventId)
    const groupStageId = [...stages].sort((a, b) => a.position - b.position)[0]!.id
    const groupIds = groups
      .filter((group) => group.stage_id === groupStageId)
      .map((group) => group.id)

    // The fixture's own falsification guard, and it can only be asked once the ids
    // exist: if the minted ids happened to sort the way the positions do, every
    // assertion below would still pass and none of them would mean anything. One uuid
    // permutation in `6!` does, so this is a real (if rare) possibility and not a
    // formality — fail here, where the reason is legible, rather than three screens
    // away.
    expect(
      sortedByCodepoint(groupIds),
      'the minted group ids must sort DIFFERENTLY from their positions, or this spec cannot fail',
    ).not.toEqual(groupIds)

    // ----- 1. the SERVER stamped the order the director sent ------------------
    // Positions 0…5 against the reservations in the sent order, and — in lockstep —
    // against the groups the server minted for them. Neither a client could have
    // produced: `position` is not a field either write shape may send.
    const storedReservations = await getEventReservations(director, tournamentId, eventId)
    expect(storedReservations.map((reservation) => reservation.id)).toEqual(
      reservationIds,
    )
    expect(storedReservations.map((reservation) => reservation.position)).toEqual(
      RESERVATIONS.map((_, index) => index),
    )
    // Scoped to the GROUP STAGE (`groupStageId`, resolved above) — `getEventGroups`
    // returns every stage's rows now (ADR 20260823, #1484), and this `rr-then-ko`
    // event's knockout stage holds one more, at `position: 0`, sharing that number
    // with the group stage's own first group.
    const storedGroups = (await getEventGroups(director, tournamentId, eventId)).filter(
      (group) => group.stage_id === groupStageId,
    )
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

    // ----- 3. the BROWSER renders the six groups in position order ------------
    // One statement, and it pins both the count and the order: six headings reading
    // Group A … Group F, top to bottom. This alone cannot distinguish a stack that
    // ordered groups by id from one that ordered by position — a computed label reads
    // in alphabet order either way — which is exactly why the membership check below
    // is the one that matters. (The bracket's own "Bracket" heading is a sibling `h4`
    // this locator never sees — see `groupDrawHeadings`'s own scoping.)
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
      const dealt = dealtTo(index)
      await expect(
        detail.groupEntrants(eventId, label),
        `${label} holds the wrong entrants — the draw was dealt in the wrong group order`,
      ).toHaveText(dealt.map((registrationIndex) => entrants[registrationIndex].username))
    }

    // ----- 2. and the WIRE carried that order to get here ---------------------
    // Read last, of the draw the browser just cut: the detail's fixtures come back
    // ordered by their group's position WITHIN its own stage (knockout fixtures sort
    // after every group-stage one, ADR 20260801's own ordering), so the GROUP STAGE's
    // group ids in first-appearance order are the server's own statement of the
    // event's group order — the one the page above rendered.
    const schedule = await getScheduleDetail(director, tournamentId)
    const fixtures = schedule.events.find((e) => e.id === eventId)?.fixtures ?? []
    // Group-stage fixtures only — `rr-then-ko` also cuts the knockout bracket upfront in
    // the same stroke (ADR "rr-then-ko cuts both stages upfront"), and this spec's
    // subject is group order, not the bracket's own bye arithmetic. See
    // `GROUP_STAGE_FIXTURE_COUNT`. Scoped by `stage_id` (`groupStageId`, resolved
    // above), never `group_id`, which no longer tells the two stages apart (ADR
    // 20260823, #1484: every fixture of both stages now names a real group).
    const groupStageFixtures = fixtures.filter(
      (fixture) => fixture.stage_id === groupStageId,
    )
    expect(groupStageFixtures).toHaveLength(GROUP_STAGE_FIXTURE_COUNT)
    const groupIdsOnTheWire = [
      ...new Set(groupStageFixtures.map((fixture) => fixture.group_id)),
    ]
    expect(groupIdsOnTheWire).toEqual(groupIds)

    await Promise.all(entrants.map((entrant) => entrant.ctx.dispose()))
  })
})
