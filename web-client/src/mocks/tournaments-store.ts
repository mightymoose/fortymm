// Dev-only in-memory store backing the MSW `/v1/tournaments` handlers. There is
// no backend in `npm run dev`: the seed loads once, mutations rewrite this
// module's array, and everything resets on reload. PATCH/DELETE (tournament and
// event) enforce the same creator-only rule the real API does — a
// `can_edit: false` row (created by someone else) returns 403.
//
// The READS are gated too (#967): a draft is owner-only, so `listTournaments` and
// `findTournament` below apply the server's visibility predicate and another
// organiser's draft is neither listed nor readable (a 404, never a 403). The store
// holds such a row on purpose — see the seed — because a mock that simply omitted
// it would leave the rule it is meant to mirror standing on nothing.
//
// Entries (ADR-0016) are modelled the way the server models them: an event
// stores its *active entrants* and NOTHING ELSE — the `entered` count is derived
// (`entrants.length`) at read time by `readEvent` below, so the count and the
// list it counts cannot drift apart. Withdrawing drops the entrant, which is
// indistinguishable, from the wire, from the server's soft-delete: a withdrawn
// entry appears in neither the list nor the count, and the player may enter
// again afterwards (the server's partial unique index; here, simply a fresh row).

import type { components } from '@/api/schema'
import { FORTYMM_LEAGUE_ID } from '@/mocks/factories/players/player-league.factory'
import {
  buildTournamentFixtureRead,
  DRAW_TYPE_CATALOGUE,
  entryStateFor,
  mintStageReads,
  planDraw,
  planRoundRobinFixtures,
  type DrawPlan,
} from '@/mocks/factories/tournaments/tournament.factory'
import {
  groupIdFor,
  groupsForEvent,
  manualPlacementPin,
  NO_DRAWN_EVENTS_MESSAGE,
  queuedSolveRow,
  simFixtureTime,
  SOLVE_TICK_DWELL_MS,
  solveRowInFlight,
  stepScheduleSolve,
} from '@/mocks/factories/tournaments/solver-sim'
import { mockUuid } from '@/mocks/mock-uuid'
import {
  BAY_AREA_OPEN_ID,
  CLUB_CHAMPS_ID,
  GARAGE_INVITATIONAL_ID,
  GOLDEN_STATE_CLASSIC_ID,
  LEAGUE_OFFICE_DRAFT_ID,
  SUMMER_SLAM_ID,
} from '@/mocks/factories/tournaments/tournament-ids'
import { conjoinWithAnd, hasVenue } from '@/components/tournaments/data/helpers'
import type { TournamentsNearMe } from '@/components/tournaments/data/api'
import { groupLetter } from '@/components/tournaments/data/draw-structure'

type TournamentDetailRead = components['schemas']['TournamentDetailRead']
type TournamentRead = components['schemas']['TournamentRead']
type TournamentStatus = components['schemas']['TournamentStatus']
type TournamentEventRead = components['schemas']['TournamentEventRead']
type TournamentCreate = components['schemas']['TournamentCreate']
type TournamentUpdate = components['schemas']['TournamentUpdate']
type Address = components['schemas']['Address']
type AddressInput = components['schemas']['AddressInput']
type TournamentEventCreate = components['schemas']['TournamentEventCreate']
type TournamentEventUpdate = components['schemas']['TournamentEventUpdate']
type TournamentFixtureRead = components['schemas']['TournamentFixtureRead']
/** A table as it is **read back**: what the client wrote, plus the id the server
 * minted for it. `id` is required here — clients no longer author one (ADR 20260801). */
type TournamentTable = components['schemas']['TournamentTable']
/** A table as a **create** body carries it: `label` and `court`, and deliberately no
 * `id` — a tournament being born has no tables an id could name. */
type TournamentTableWrite = components['schemas']['TournamentTableWrite']
/** A table as an **edit** body carries it: the write shape plus an *optional* `id`
 * naming a table the tournament already has. Omitted means "add this one"; supplied
 * means "this existing one". A stored table no entry names is removed. */
type TournamentTableUpsert = components['schemas']['TournamentTableUpsert']
type TournamentEntrantRead = components['schemas']['TournamentEntrantRead']
/** The **read** reservation — it carries the `id` the server minted and the `position`
 * it stamped. Its two write twins below deliberately carry neither; see
 * `mintReservation`. */
type Reservation = components['schemas']['Reservation']
/** A reservation as a **create** body carries it: no `id` (the server mints it, ADR
 * 20260801) and no `position` (the server assigns it from the reservation's index in
 * the list). `extra="forbid"`, so either key on the way in is a 422 that names the
 * field. */
type ReservationWrite = components['schemas']['ReservationWrite']
/** A reservation as a **PATCH** body carries it: the write shape plus an *optional* `id`
 * naming a reservation the event already has. Omitted means "add this one"; supplied
 * means "this existing one". A stored reservation no entry names is removed. */
type ReservationUpsert = components['schemas']['ReservationUpsert']
// `GroupRead` has no type alias here: it is never authored or held by this store
// (ticket #1369) — `groupIdFor`/`groupsFor` (`solver-sim.ts`, shared with the Playwright
// stub) derive it from `StoredEvent.reservations` at read time, so the 1:1 this slice
// keeps can never drift out of step by itself.
type ScheduleSolveRead = components['schemas']['ScheduleSolveRead']

/** What the store actually holds for an event: everything the wire shape has
 * *except* the three fields the server DERIVES at read time — the `entered` count,
 * the caller-aware `entry_state`, and `groups` (ticket #1369: server-minted, one per
 * reservation, at the same position — never a second array a mutation could let drift
 * out of the 1:1). Deriving them on read (rather than storing them) makes "the counter
 * says 52, the list has 51" — and its twin, "the event says `open` while holding all 64
 * of its 64 entrants" — unrepresentable. It is the same reason the API has no `entered`
 * column, and `groupsFor` (below) is the same discipline applied to `groups`.
 *
 * The one thing the store DOES hold is `ineligible`: whether the dev user's rating
 * fails one of this event's rules is a fact about a player's rating on the
 * tournament's ladder (ADR-0783), and no mock payload carries a ladder — so it is
 * seeded rather than computed, and `readEvent` turns it into the wire's
 * `rating_ineligible`.
 *
 * `fixtures` — the event's DRAW (ADR-0786) — *is* stored, and is not derived from
 * anything: a draw is an explicit act (`POST …/draw`), not a function of the entrants,
 * so `[]` is the real state of an event nobody has cut a draw for, and the only things
 * that ever change it are the two draw verbs (`cutDraw` / `uncutDraw` below). An event
 * PATCH deliberately leaves it alone — a director editing an event's name has not
 * thrown their draw away.
 *
 * `qualifiers_per_group` is stored too, and it has to be: it is what sizes an
 * `rr-then-ko` draw's bracket at the cut (`P × K`, ADR 20260727). Before it had a home
 * here, `planEventDraw` passed nothing and every two-stage event was cut at one qualifier
 * per group — a well-formed bracket of the wrong size, for an event the director had
 * configured otherwise, with nothing reporting the substitution.
 *
 * **It is `null` for every draw type but `rr-then-ko`** (ADR 20260727), which is why the
 * seed below states the bare literal and says no more: no knockout stage to qualify for,
 * so no qualifier count — `null` is the only value those draw types' settings row admits,
 * and it is not "unset".
 *
 * `rounds` is stored on exactly the same terms (the swiss ADR): it is what sizes a swiss
 * draw at the cut (`R × ⌊n/2⌋` fixtures, all of them written up front), it is `null` for
 * every draw type but `swiss`, and `null` is not "unset" there either — a round-robin's
 * rounds come off the circle method and a bracket's depth follows from the field, so
 * neither is a number anybody chooses. */
type StoredEvent = Omit<TournamentEventRead, 'entered' | 'entry_state' | 'groups'> & {
  /** Seeded: the dev user is refused by this rule, at this rating. */
  ineligible?: { predicate_id: string; rating: number }
}

/** What the store holds for a tournament: the wire shape minus its events (which are
 * stored in their own reduced form above) and minus `draw_type_catalogue`.
 *
 * The catalogue is **global reference data, not a fact about a row** — the `draw_types`
 * table, which every tournament shares — and it is page data besides: the DETAIL payload
 * carries it and the LIST payload sends `null` (ADR "a draw type is a seeded row, and the
 * enum holds only what runs"). Seeding it per tournament would let two rows disagree
 * about what the server's table holds, and would leave each read shape's answer to
 * whoever wrote the seed. So it is not stored at all: `readDetail` and `readListRow`
 * below decide it, one place each. */
type StoredTournament = Omit<
  TournamentDetailRead,
  'events' | 'draw_type_catalogue'
> & {
  events: StoredEvent[]
}

// The dev current user — must line up with the mocked session in handlers.ts so
// `can_edit` reads true for rows this user owns, and so an entry created here is
// recognised as *mine* (the client matches on username: the session carries no
// user id).
const DEV_USER_ID = 'u-me'
const DEV_USERNAME = 'rita.kovac'
/** The dev user's rating on the tournaments' ladder — the one the `ev-u1200`
 * seed's rating refusal judges them on, and the one their own entry chip carries.
 * They are RATED: the unrated marker is a thing they see about *other* people, and
 * a dev user who was themselves unrated would make `(you)` the demo of it. */
const DEV_USER_RATING = 1650

// The ladder a mock tournament's eligibility rules are judged against (ADR-0783).
// Every seeded row is run on the **default** league — the one the server resolves
// an omitted `league_id` to at create — and `createTournament` below does the
// same. No surface renders it yet; it is carried so the mock sends the shape the
// wire really sends.
const DEFAULT_LEAGUE_ID = FORTYMM_LEAGUE_ID

function tables(count: number): TournamentTable[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i + 1}`,
    label: `T${i + 1}`,
    court: String(i + 1),
  }))
}

/** `count` other players already entered in an event — enough to make the fill
 * bars and the "Entries" hero stat meaningful in `npm run dev`. Deliberately
 * never the dev user, so the Enter control is offered on every seeded event.
 *
 * **Every fourth one is UNRATED** (`rating: null`) — they hold no rating on the
 * tournament's ladder, so they pass every rating rule (ADR-0783 §3) and the roster
 * marks them. Seeded into the first eight, i.e. into the chips a card actually
 * shows, so `npm run dev` shows a *mixed* roster: without an unrated entrant in the
 * seed, the one mitigation this whole decision rests on would be invisible in the
 * only place a director looks at it. The rest carry a spread of real ratings. */
function otherEntrants(eventId: string, count: number): TournamentEntrantRead[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `entry-${eventId}-${i + 1}`,
    user_id: `u-other-${i + 1}`,
    username: `player.${i + 1}`,
    seed: i < 8 ? i + 1 : null,
    rating: (i + 1) % 4 === 0 ? null : 1150 + ((i * 137) % 750),
  }))
}

/** A seeded reservation's id — a **uuid**, because that is what the wire says a
 * reservation id is (`Reservation.id` is `format: uuid`, minted by the server: ADR
 * 20260801), derived from a readable label so the seed stays greppable and the same
 * tournament comes back the same on every reset.
 *
 * Not the mint below (`mintReservation`): these rows are not created through a write
 * verb, and routing them through the counter would make a seeded reservation's id depend
 * on how many reservations the *previous* test happened to create. Distinct labels keep
 * the two id spaces from ever colliding. */
function seedReservationId(label: string): string {
  return mockUuid(`tournament-event-reservation:${label}`)
}

/** `ev-u1200`'s OWN reservation (#1482): a round-robin event holds at most one
 * reservation, so this covers every table (`t1`-`t4`) in one. */
const U1200_RESERVATION: Reservation[] = [
  {
    id: seedReservationId('u1200-single'),
    name: 'Reservation A',
    slot: { date: '2026-06-14', start: '09:00', end: '12:00' },
    table_ids: ['t1', 't2', 't3', 't4'],
    position: 0,
  },
]

/** `ev-two-stage-cut`'s two reservations (#1482) — an `rr-then-ko` event legitimately
 * holds several, so this is where the multi-reservation id-keyed-diff coverage
 * `ev-u1200` used to carry now lives. Its own ids, distinct from `U1200_RESERVATION`'s:
 * a fixture's `group_id` is derived from a reservation's id (`groupIdFor`), and two
 * different events must never derive the same one. */
const TWO_STAGE_CUT_RESERVATIONS: Reservation[] = [
  {
    id: seedReservationId('two-stage-cut-a'),
    name: 'Reservation A',
    slot: { date: '2026-06-14', start: '09:00', end: '10:30' },
    table_ids: ['t1', 't2'],
    position: 0,
  },
  {
    id: seedReservationId('two-stage-cut-b'),
    name: 'Reservation B',
    slot: { date: '2026-06-14', start: '10:30', end: '12:00' },
    table_ids: ['t3', 't4'],
    position: 1,
  },
]

/** The reservation of Summer Slam's one event — the seed's **ready-to-start**
 * tournament (see below). Pulled out for the same reason `U1200_RESERVATION` is: the
 * fixtures are planned against this very (derived) group id, so it cannot be spelled
 * twice and spelled differently.
 *
 * ONE reservation (#1482): a `round-robin` event holds at most one, so both tables
 * (`t1`–`t4`) and the whole window are in it — never two, the way this event's draw
 * used to be split. */
const SLAM_RESERVATIONS: Reservation[] = [
  {
    id: seedReservationId('slam-a'),
    name: 'Reservation A',
    slot: { date: '2026-08-22', start: '09:00', end: '13:00' },
    table_ids: ['t1', 't2', 't3', 't4'],
    position: 0,
  },
]

// ----- the seed's TWO-STAGE events (`rr-then-ko`, ADR 20260727) -------------------
//
// Two of them, on their own tournament (`GOLDEN_STATE` below): the **Challenge Cup**,
// played out to a champion, and the **Shield**, whose groups are decided while its
// bracket is still mid-flight. Between them they are the only place the results union's
// third arm
// (`kind: "standings_then_finishes"`) exists outside the server — complete and partial.
//
// They are hand-seeded, and that is not laziness: **this store derives no results at
// all.** Every seeded event states its own `results` block and `cutDraw` never writes one
// (the same seam `ev-u1200`'s standings come through), so without fixtures that spell the
// shape out, the two-stage arm is a thing only the server has ever produced.
//
// ⚠️ A results shape the client has no arm for is NOT contained by parking it on a
// tournament of its own, and believing it was cost this seed a broken app. `parseResults`
// throws on an unknown `kind` (by design — ADR 20260727 says so out loud), and the
// tournaments **list** handler returns full detail rows, results included, which the list
// query maps through that same parser. So while the third arm was seeded and unparsed, the
// throw failed the LIST query and took the entire `/tournaments` section down — every
// tournament, not just this one. The separate row buys isolation for the *detail* query
// only; nothing isolates the list.
//
// The lesson, for the next arm: **the parser and the fixture that exercises it must land
// together.** (vitest stayed green throughout, because every list test stubs the endpoint
// with a hand-built row — the suite was green about a stub. `npm run dev` was not.)
//
// The numbers below are consistent by construction and `tournaments-store.test.ts` holds
// them to it: the standings' wins and losses are the ones the GROUP FIXTURES record, the
// finishes follow single-elimination's tie shape, and the champion is the FINAL's winner
// — never a group leader.

/** The tournament both two-stage events run at: **live**, mid-weekend, with one event
 * finished and one still playing. It is also the seed's only `live` row, so `npm run dev`
 * gets a started tournament for free. */
const GOLDEN_STATE_ID = GOLDEN_STATE_CLASSIC_ID

const CUP_EVENT_ID = 'ev-challenge-cup'
const SHIELD_EVENT_ID = 'ev-shield'

/** An event's entrant ids in registration order — read off `otherEntrants` rather than
 * spelled out, so the ids a results block names and the ids the event actually holds
 * cannot drift apart. `player.N`'s id is at index `N − 1`, which is what lets the outcome
 * tables below read as the matches a director would recognise (`cup(5)` beat `cup(1)`)
 * instead of as array indices. */
const CUP_ENTRY_IDS = otherEntrants(CUP_EVENT_ID, 8).map((e) => e.id)
const SHIELD_ENTRY_IDS = otherEntrants(SHIELD_EVENT_ID, 6).map((e) => e.id)

const cup = (n: number): string => CUP_ENTRY_IDS[n - 1]
const shield = (n: number): string => SHIELD_ENTRY_IDS[n - 1]

/** The Challenge Cup's two reservations. Pulled out of the seed for the reason
 * `TWO_STAGE_CUT_RESERVATIONS` is — the fixtures are planned against these very
 * (derived) group ids, so they cannot be spelled twice and spelled differently. */
const CUP_RESERVATIONS: Reservation[] = [
  {
    id: seedReservationId('cup-a'),
    name: 'Reservation A',
    slot: { date: '2026-06-06', start: '09:00', end: '11:00' },
    table_ids: ['t1', 't2'],
    position: 0,
  },
  {
    id: seedReservationId('cup-b'),
    name: 'Reservation B',
    slot: { date: '2026-06-06', start: '11:00', end: '13:00' },
    table_ids: ['t3', 't4'],
    position: 1,
  },
]

/** The Shield's two reservations — a day later and on the other four tables, so the
 * tournament raises no double-booking diagnostic (`findReservationConflicts`). */
const SHIELD_RESERVATIONS: Reservation[] = [
  {
    id: seedReservationId('shield-a'),
    name: 'Reservation A',
    slot: { date: '2026-06-07', start: '09:00', end: '10:30' },
    table_ids: ['t5', 't6'],
    position: 0,
  },
  {
    id: seedReservationId('shield-b'),
    name: 'Reservation B',
    slot: { date: '2026-06-07', start: '10:30', end: '12:00' },
    table_ids: ['t7', 't8'],
    position: 1,
  },
]

/** One played group match: `[winner, loser, winner's games, loser's games]` over an
 * event's `player.N` numbering. Best-of-three throughout (`length_games: 3`), so every
 * score is `2–0` or `2–1`. */
type GroupPlay = readonly [number, number, number, number]

/**
 * Every group match the **Challenge Cup** played — the play its standings block reports.
 *
 * Written out as OUTCOMES rather than as the standings themselves, because the two are
 * the seed's two independent statements about the same group stage: this table stamps each
 * planned group fixture with its `winner_entry_id`, the results block states the table a
 * director reads, and the store's test derives the first into the second and fails if they
 * disagree. A single hand-written standings block with nothing to check it against is a
 * block whose arithmetic rots the first time somebody edits a row.
 */
const CUP_GROUP_PLAY: readonly GroupPlay[] = [
  // Group A (`player.1`, `.4`, `.5`, `.8` — the snake's deal): `player.5` unbeaten,
  // `player.1` second on 2–1, then `player.4`, then a winless `player.8`. No tie, so the
  // finishing order is wins alone.
  [5, 1, 2, 1],
  [1, 4, 2, 0],
  [1, 8, 2, 0],
  [5, 4, 2, 0],
  [4, 8, 2, 1],
  [5, 8, 2, 0],
  // Group B (`player.2`, `.3`, `.6`, `.7`): TWO ties, both broken by **two-way
  // head-to-head** — the first tiebreak the finishing order falls through to
  // (`player.3` over `player.2` at 2–1 each, `player.6` over `player.7` at 1–2 each).
  // Seeded deliberately: a group where wins alone settle everything leaves the chain the
  // qualifiers are chosen by completely unexercised. The game difference agrees with
  // head-to-head in both cases, so the table still reads top-to-bottom without a director
  // having to know why.
  [3, 2, 2, 0],
  [2, 6, 2, 1],
  [2, 7, 2, 1],
  [3, 6, 2, 1],
  [7, 3, 2, 1],
  [6, 7, 2, 0],
]

/**
 * Every group match the **Shield** played. Both groups are decided; the knockout stage is
 * not (see `SHIELD_KNOCKOUT_FIXTURES`).
 *
 * Group A is a **three-way tie** — everybody 1–1 — which head-to-head cannot break (it
 * only settles a *two*-way one), so the order falls through to game difference:
 * `player.1` (+1), `player.5` (0), `player.4` (−1). That is the next link of the same
 * chain the Cup's Group B exercises, and between them the two events cover it.
 */
const SHIELD_GROUP_PLAY: readonly GroupPlay[] = [
  // Group A — `player.1`, `.4`, `.5`.
  [1, 4, 2, 0],
  [5, 1, 2, 1],
  [4, 5, 2, 1],
  // Group B — `player.2`, `.3`, `.6`: no tie at all. `player.2` unbeaten, `player.6`
  // winless.
  [2, 3, 2, 1],
  [3, 6, 2, 0],
  [2, 6, 2, 0],
]

/** `entry id | entry id` (sorted) → the winner's entry id, for every group match of one
 * event. The lookup `stampGroupWinners` uses to record play on the PLANNED fixtures, so
 * the draw the store would have cut and the play the results report are one thing. */
function groupWinnersOf(
  play: readonly GroupPlay[],
  entryOf: (n: number) => string,
): Map<string, string> {
  return new Map(
    play.map(([winner, loser]) => [
      [entryOf(winner), entryOf(loser)].sort().join('|'),
      entryOf(winner),
    ]),
  )
}

const CUP_GROUP_WINNERS = groupWinnersOf(CUP_GROUP_PLAY, cup)
const SHIELD_GROUP_WINNERS = groupWinnersOf(SHIELD_GROUP_PLAY, shield)

/** Record an event's play on its planned group fixtures — the state a decided group's
 * fixtures are really in. The play table names every pairing exactly once, so a fixture
 * with no entry in the map is a planner/seed disagreement rather than an unplayed match,
 * and it throws here rather than seeding a half-played group nobody notices. */
function stampGroupWinners(
  fixtures: TournamentFixtureRead[],
  winners: ReadonlyMap<string, string>,
): TournamentFixtureRead[] {
  return fixtures.map((fixture) => {
    const key = [fixture.entry_a_id, fixture.entry_b_id].sort().join('|')
    const winner = winners.get(key)
    if (winner === undefined) {
      throw new Error(`seed: no group result for fixture ${fixture.id}`)
    }
    return { ...fixture, winner_entry_id: winner }
  })
}

/**
 * The Challenge Cup's knockout stage, **played out** — the state the bracket reaches once
 * every group has finished, `advance()` has seated its qualifiers, and all three matches
 * have been won.
 *
 * Written out rather than planned, because seating a qualifier and carrying a winner
 * forward are `advance()`'s job on the server and this store implements neither. What
 * keeps it honest is a test: the seeded bracket's `(id, group_id, round, position)` shape
 * is asserted equal to the one `planDraw('rr-then-ko', …)` cuts for this very field, so
 * this is that bracket with its sides filled in — never a differently-shaped one.
 *
 * **Who plays whom is the ADR's seeding, not a choice made here.** Qualifiers are ordered
 * place-major — both group winners (`player.5`, `player.3`) outrank both runners-up
 * (`player.1`, `player.2`) — and the group order *within* a place is picked so round one
 * pairs nobody with a group-mate: seeds 1–4 are `player.5`, `player.3`, `player.1`,
 * `player.2`, and a 4-bracket pairs 1 v 4 and 2 v 3, i.e. A-winner v B-runner-up and
 * B-winner v A-runner-up.
 *
 * **And both group winners lose in round one.** That is the point of the fixture: the
 * champion is `player.2`, who came SECOND in group B, and the two entrants who topped
 * their groups finish tied 3rd. Crown the group leader instead and nothing on screen can
 * tell "champion from the bracket" (the ADR's decision) from "champion from the
 * standings".
 */
const CUP_KNOCKOUT_FIXTURES: TournamentFixtureRead[] = [
  // Semifinal 1 — seed 1 (`player.5`, group A's winner) v seed 4 (`player.2`, group B's
  // runner-up). The runner-up wins. `stage_id: 's-2'` — `mintStageReads`'s knockout
  // stage of this `rr-then-ko` event (ADR 20260815), never the group stage's `'s-1'`.
  buildTournamentFixtureRead({
    id: 'fx-ko-r1-p1',
    stage_id: 's-2',
    group_id: null,
    round: 1,
    position: 1,
    entry_a_id: cup(5),
    entry_b_id: cup(2),
    winner_entry_id: cup(2),
  }),
  // Semifinal 2 — seed 2 (`player.3`, group B's winner) v seed 3 (`player.1`, group A's
  // runner-up). The runner-up wins again.
  buildTournamentFixtureRead({
    id: 'fx-ko-r1-p2',
    stage_id: 's-2',
    group_id: null,
    round: 1,
    position: 2,
    entry_a_id: cup(3),
    entry_b_id: cup(1),
    winner_entry_id: cup(1),
  }),
  // The final — two runners-up, and `player.2` takes it. THIS fixture's winner is the
  // event's champion; the standings have no say in it.
  buildTournamentFixtureRead({
    id: 'fx-ko-r2-p1',
    stage_id: 's-2',
    group_id: null,
    round: 2,
    position: 1,
    entry_a_id: cup(2),
    entry_b_id: cup(1),
    winner_entry_id: cup(2),
  }),
]

/**
 * The Shield's knockout stage, **mid-flight** — both semifinals won, the final seated and
 * still to be played.
 *
 * This is the state the two-stage results shape spends most of a tournament in, and the
 * reason it is seeded alongside the finished Cup: `complete` is false because the SECOND
 * stage is undecided even though every group is done, `champion` is `null` because no
 * final has been won, and `finishes` holds only the two entrants the bracket has actually
 * placed — the beaten semifinalists, tied 3rd. A results panel built solely against the
 * finished event would never meet a finishes list that starts at position 3.
 *
 * Seeds 1–4 are `player.1`, `player.2` (the group winners) then `player.5`, `player.3`
 * (the runners-up), by the same place-major, group-mate-avoiding rule the Cup uses.
 */
const SHIELD_KNOCKOUT_FIXTURES: TournamentFixtureRead[] = [
  // Semifinal 1 — seed 1 (`player.1`, group A) v seed 4 (`player.3`, group B). The top
  // seed holds. `stage_id: 's-2'` — `mintStageReads`'s knockout stage of this
  // `rr-then-ko` event (ADR 20260815), never the group stage's `'s-1'`.
  buildTournamentFixtureRead({
    id: 'fx-ko-r1-p1',
    stage_id: 's-2',
    group_id: null,
    round: 1,
    position: 1,
    entry_a_id: shield(1),
    entry_b_id: shield(3),
    winner_entry_id: shield(1),
  }),
  // Semifinal 2 — seed 2 (`player.2`, group B's winner) v seed 3 (`player.5`, group A's
  // runner-up), and the runner-up takes it.
  buildTournamentFixtureRead({
    id: 'fx-ko-r1-p2',
    stage_id: 's-2',
    group_id: null,
    round: 1,
    position: 2,
    entry_a_id: shield(2),
    entry_b_id: shield(5),
    winner_entry_id: shield(5),
  }),
  // The final: both sides SEATED — `advance()` has carried the semifinal winners in — and
  // no winner recorded. A ready fixture waiting to be played, which is precisely why this
  // event has no champion yet.
  buildTournamentFixtureRead({
    id: 'fx-ko-r2-p1',
    stage_id: 's-2',
    group_id: null,
    round: 2,
    position: 1,
    entry_a_id: shield(1),
    entry_b_id: shield(5),
    winner_entry_id: null,
  }),
]

function seed(): StoredTournament[] {
  return [
    {
      id: BAY_AREA_OPEN_ID,
      name: 'Bay Area Open 2026',
      description: 'Two-day open. USATT-sanctioned, ratings-eligible.',
      status: 'published',
      start_date: '2026-06-13',
      end_date: '2026-06-14',
      league_id: DEFAULT_LEAGUE_ID,
      address: {
        venue: 'Berkeley TT Club',
        street: '2727 Milvia St',
        city: 'Berkeley',
        region: 'CA',
        postal: '94703',
        country: 'USA',
        latitude: 37.8715,
        longitude: -122.273,
      },
      table_catalogue: tables(12),
      created_by_user_id: DEV_USER_ID,
      created_by_username: DEV_USERNAME,
      can_edit: true,
      created_at: '2026-06-01T09:00:00Z',
      updated_at: '2026-06-10T12:00:00Z',
      // NO SOLVE YET — the state every tournament is born in. The Run-scheduler
      // button (`requestScheduleSolve` below) is what puts a row here, and the
      // mock's read tick then walks it queued → running → succeeded so `npm run
      // dev` demos the whole loop.
      latest_schedule_solve: null,
      events: [
        {
          id: 'ev-open-singles',
          tournament_id: BAY_AREA_OPEN_ID,
          name: 'Open Singles',
          format: 'singles',
          draw_type: 'round-robin',
          // System-minted, never authored (ADR 20260815) — `mintStageReads` keeps every
          // seeded event's `stages` agreeing with its own `draw_type`, one place.
          stages: mintStageReads('round-robin'),
          qualifiers_per_group: null,
          rounds: null,
          max_players: 64,
          entry_fee: 45,
          timezone: 'America/Chicago',
          entrants: otherEntrants('ev-open-singles', 52),
          slot: { date: '2026-06-13', start: '09:00', end: '18:00' },
          match_settings: { rated: true, length_games: 5 },
          predicates: [],
          // ONE reservation (#1482): a `round-robin` event runs one group, so it holds
          // at most one reservation. Every table the two former reservations covered is
          // now in this one, per the rule's own instruction ("put every table in the one
          // reservation"). Nothing reads this event's reservations (foreign-tournament
          // tests aside), so the collapse costs no coverage.
          reservations: [
            {
              id: 'p-os-1',
              name: 'Reservation A',
              slot: { date: '2026-06-13', start: '09:00', end: '18:00' },
              table_ids: ['t1', 't2', 't3', 't4', 't5', 't6'],
              position: 0,
            },
          ],
          // NO DRAW CUT (ADR-0786) — the state every event starts in, and the state
          // all but one of this seed's events stay in. `[]`, never null.
          fixtures: [],
          // NO RESULTS (ADR-0788) — no draw, so nothing to stand.
          results: null,
          created_at: '2026-06-01T09:05:00Z',
          updated_at: '2026-06-09T12:00:00Z',
        },
        {
          // Deliberately empty: the designed empty entrants state, and the event
          // whose count a dev demo ticks from 0 to 1.
          //
          // It is ALSO the seed's **uncuttable** event — still, after #1484, just for a
          // DIFFERENT reason than it used to be. Do not give it reservations: that is
          // not what keeps it uncuttable any more.
          //
          // The gap this comment used to name is now closed: since ADR 20260823 every
          // standalone event's one stage holds exactly one group, whatever its
          // reservation count (0 or 1, #1482's cap) — decoupled entirely, the same way
          // #1483 already decoupled single-elim's and swiss's. So this event has ONE
          // group on every read (`groupsForEvent`), never zero, and `planEventDraw`
          // hands the cut that same one group id — never `event.reservations.map(...)`
          // — so the read and the cut cannot disagree. `snakeRefusal`'s "needs at least
          // one group" branch is now UNREACHABLE for a round-robin event: the count is
          // never zero any more. This event stays uncuttable on its EMPTY FIELD instead:
          // `snakedGroups([], 1)` deals nobody into that one group, so it fails the
          // per-group floor and refuses "0 entrants across 1 group would leave a group
          // with fewer than 2 entrants, who would have nobody to play." — the server's
          // OTHER round-robin refusal, not the one this event used to demonstrate.
          id: 'ev-u1500',
          tournament_id: BAY_AREA_OPEN_ID,
          name: 'U1500 Singles',
          format: 'singles',
          draw_type: 'round-robin',
          stages: mintStageReads('round-robin'),
          qualifiers_per_group: null,
          rounds: null,
          max_players: 48,
          entry_fee: 30,
          timezone: 'America/Los_Angeles',
          entrants: [],
          slot: { date: '2026-06-14', start: '09:00', end: '16:00' },
          match_settings: { rated: true, length_games: 3 },
          predicates: [{ id: 'pr-2', field: 'rating', op: '<', value: 1500 }],
          reservations: [],
          fixtures: [],
          results: null,
          created_at: '2026-06-01T09:06:00Z',
          updated_at: '2026-06-09T12:00:00Z',
        },
        {
          // FULL: 16 entrants in 16 places, so `entryState` reads `event_full` off
          // the entrants themselves. The card offers no Enter button at all — it
          // says why instead (ADR-0015; #783). Seeded so `npm run dev` can show the
          // state without anyone having to click Enter sixteen times.
          id: 'ev-champ-singles',
          tournament_id: BAY_AREA_OPEN_ID,
          name: 'Championship Singles',
          format: 'singles',
          draw_type: 'single-elim',
          stages: mintStageReads('single-elim'),
          qualifiers_per_group: null,
          rounds: null,
          max_players: 16,
          entry_fee: 60,
          timezone: 'America/Los_Angeles',
          entrants: otherEntrants('ev-champ-singles', 16),
          slot: { date: '2026-06-14', start: '13:00', end: '18:00' },
          match_settings: { rated: true, length_games: 7 },
          predicates: [],
          reservations: [],
          fixtures: [],
          results: null,
          created_at: '2026-06-01T09:06:30Z',
          updated_at: '2026-06-09T12:00:00Z',
        },
        {
          // RATING-INELIGIBLE: the dev user is rated 1650 on the tournament's
          // ladder and this event admits only players under 1200, so the server
          // refuses them — naming the rule that did it (`predicate_id`), which the
          // card reads back out of the event's own `predicates`. Not derivable from
          // the event alone (there is no ladder in a mock), so it is seeded.
          //
          // It is ALSO the seed's one **drawn, COMPLETE** event (ADR-0786) — the only
          // one that arrives with fixtures already, so `npm run dev` can show a cut
          // draw without anyone clicking Generate. Round-robin, because a GROUPED draw
          // is the one whose scaffold (groups, rounds, the sit-out) needs seeing
          // without anybody clicking; the bracket is one Generate click away on any
          // single-elim event.
          //
          // ONE reservation, and therefore ONE group (#1482: a round-robin event holds
          // at most one) — nine entrants all in it, an ODD group, so its rounds have a
          // player sitting out each time, and a bye is visible for what it is: the
          // ABSENCE of a fixture, not a fixture with an empty side. Complete, and ONE
          // group, so it has a champion (CONTEXT.md, "Champion": the leader of the
          // standings). Before the cap this same event could have been seeded across
          // two reservations, and a complete TWO-group round-robin has no champion at
          // all — nothing joins its two group winners. The cap is what makes a
          // round-robin event's champion unconditional; it did not give a multi-group
          // round-robin one.
          id: 'ev-u1200',
          tournament_id: BAY_AREA_OPEN_ID,
          name: 'U1200 Singles',
          format: 'singles',
          draw_type: 'round-robin',
          stages: mintStageReads('round-robin'),
          qualifiers_per_group: null,
          rounds: null,
          max_players: 24,
          entry_fee: 20,
          timezone: 'America/Los_Angeles',
          entrants: otherEntrants('ev-u1200', 9),
          slot: { date: '2026-06-14', start: '09:00', end: '12:00' },
          match_settings: { rated: true, length_games: 3 },
          predicates: [{ id: 'pr-u1200', field: 'rating', op: '<', value: 1200 }],
          ineligible: { predicate_id: 'pr-u1200', rating: DEV_USER_RATING },
          reservations: U1200_RESERVATION,
          // Planned by the same function the store's `cutDraw` uses, from the same
          // entrants and the same (derived) group id — so the seeded draw is one this
          // store could have cut, rather than a hand-written list that no cut would ever
          // produce.
          fixtures: planRoundRobinFixtures(
            otherEntrants('ev-u1200', 9).map((e) => e.id),
            U1200_RESERVATION.map((r) => groupIdFor(r.id)),
          ),
          // COMPLETE results (ADR-0788), so `npm run dev` shows a champion live — the
          // one state #1482 makes reachable for the first time: a round-robin event now
          // holds one group, so `len(standings) === 1` is always true for a complete one
          // (CONTEXT.md's Champion entry, edited here). The entry ids match this event's
          // entrants (`entry-ev-u1200-N`) and its group id (`groupIdFor`, off
          // `U1200_RESERVATION`, never respelled), so the name and group joins land; the
          // rows are in finishing order, which the client renders untouched.
          results: {
            kind: 'standings',
            complete: true,
            champion: 'entry-ev-u1200-1',
            groups: [
              {
                group_id: groupIdFor(U1200_RESERVATION[0].id),
                complete: true,
                rows: [
                  { entry_id: 'entry-ev-u1200-1', rank: 1, played: 8, wins: 8, losses: 0, games_won: 16, games_lost: 4, game_difference: 12 },
                  { entry_id: 'entry-ev-u1200-2', rank: 2, played: 8, wins: 7, losses: 1, games_won: 15, games_lost: 6, game_difference: 9 },
                  { entry_id: 'entry-ev-u1200-3', rank: 3, played: 8, wins: 6, losses: 2, games_won: 14, games_lost: 8, game_difference: 6 },
                  { entry_id: 'entry-ev-u1200-4', rank: 4, played: 8, wins: 5, losses: 3, games_won: 13, games_lost: 10, game_difference: 3 },
                  { entry_id: 'entry-ev-u1200-5', rank: 5, played: 8, wins: 4, losses: 4, games_won: 12, games_lost: 12, game_difference: 0 },
                  { entry_id: 'entry-ev-u1200-6', rank: 6, played: 8, wins: 3, losses: 5, games_won: 10, games_lost: 13, game_difference: -3 },
                  { entry_id: 'entry-ev-u1200-7', rank: 7, played: 8, wins: 2, losses: 6, games_won: 8, games_lost: 14, game_difference: -6 },
                  { entry_id: 'entry-ev-u1200-8', rank: 8, played: 8, wins: 1, losses: 7, games_won: 6, games_lost: 15, game_difference: -9 },
                  { entry_id: 'entry-ev-u1200-9', rank: 9, played: 8, wins: 0, losses: 8, games_won: 4, games_lost: 16, game_difference: -12 },
                ],
              },
            ],
          },
          created_at: '2026-06-01T09:06:45Z',
          updated_at: '2026-06-09T12:00:00Z',
        },
        {
          // TWO reservations, `rr-then-ko` (#1482): the one draw type the cap does not
          // apply to, so it is where the multi-reservation id-keyed-diff coverage
          // `ev-u1200` used to carry now lives (`tournaments-store.test.ts`, "the group
          // set freezes while a draw exists" / "a reservations PATCH citing an id the
          // event does not have" / "the draw type freezes while a draw exists"). Drawn
          // for the freeze mechanics only — the two-group `standings_then_finishes`
          // DEMO already lives at the Cup and the Shield below, so this fixture states
          // no results at all.
          id: 'ev-two-stage-cut',
          tournament_id: BAY_AREA_OPEN_ID,
          name: 'Two-stage Singles (cut)',
          format: 'singles',
          draw_type: 'rr-then-ko',
          stages: mintStageReads('rr-then-ko'),
          qualifiers_per_group: 2,
          rounds: null,
          // Matches the entrant count below, the same convention the Cup and the
          // Shield use — this event's GROUP STAGE still derives its count from
          // `reservations.length` alone (`groupsForEvent`'s `rr-then-ko` arm), a
          // pre-existing divergence from the real server's `ceil(field / 5)` that
          // #1484 deliberately leaves open (see `groupsFor`'s own doc,
          // `mocks/factories/tournaments/solver-sim.ts`: this mock has never modelled
          // that formula, and closing it is not this ticket's job). A field this
          // fixture's TWO reservations would derive differently under that real
          // formula (`ceil(9/5) = 2`, which happens to agree) is a coincidence worth
          // keeping rather than a field far enough off to make the divergence more
          // visible than it already is on `main`.
          //
          // What #1484 DOES change here: this event's KNOCKOUT stage now also holds
          // one group (`groupsForEvent`'s new stage-1 arm) — at `position: 0`, mapped
          // to `reservations[0]` by the same `position % reservation count` rule its
          // group stage's own position-0 group already follows, and with its own id
          // (never `groupIdFor(reservations[0].id)`, which the group stage's group
          // already holds). Nothing below adds knockout fixtures for it to confine —
          // this event's `fixtures` stay group-stage-only, for the freeze mechanics
          // this seed exists to cover — so the new group rides on the wire unused by
          // any fixture, exactly as it would on a real event that has not been fully
          // cut yet.
          max_players: 9,
          entry_fee: 20,
          timezone: 'America/Los_Angeles',
          entrants: otherEntrants('ev-two-stage-cut', 9),
          slot: { date: '2026-06-14', start: '09:00', end: '12:00' },
          match_settings: { rated: true, length_games: 3 },
          predicates: [],
          reservations: TWO_STAGE_CUT_RESERVATIONS,
          fixtures: planRoundRobinFixtures(
            otherEntrants('ev-two-stage-cut', 9).map((e) => e.id),
            TWO_STAGE_CUT_RESERVATIONS.map((r) => groupIdFor(r.id)),
          ),
          results: null,
          created_at: '2026-06-01T09:06:45Z',
          updated_at: '2026-06-09T12:00:00Z',
        },
        {
          // A doubles event: entry is a singles-only affair (one row per user
          // cannot express a pairing — ADR-0016), so the API 400s here and the
          // UI offers no Enter control. Seeded so that case is visible in dev.
          id: 'ev-mixed-doubles',
          tournament_id: BAY_AREA_OPEN_ID,
          name: 'Mixed Doubles',
          format: 'doubles',
          draw_type: 'single-elim',
          stages: mintStageReads('single-elim'),
          qualifiers_per_group: null,
          rounds: null,
          max_players: 32,
          entry_fee: 25,
          timezone: 'America/Los_Angeles',
          entrants: [],
          slot: { date: '2026-06-14', start: '10:00', end: '15:00' },
          match_settings: { rated: false, length_games: 3 },
          predicates: [],
          reservations: [],
          fixtures: [],
          results: null,
          created_at: '2026-06-01T09:07:00Z',
          updated_at: '2026-06-09T12:00:00Z',
        },
      ],
    },
    {
      id: SUMMER_SLAM_ID,
      name: 'Summer Slam 2026',
      description: null,
      status: 'draft',
      start_date: '2026-08-22',
      end_date: '2026-08-23',
      league_id: DEFAULT_LEAGUE_ID,
      address: {
        venue: 'Palo Alto Community Center',
        street: '1313 Newell Rd',
        city: 'Palo Alto',
        region: 'CA',
        postal: '94303',
        country: 'USA',
        latitude: 37.4419,
        longitude: -122.143,
      },
      table_catalogue: tables(8),
      created_by_user_id: DEV_USER_ID,
      created_by_username: DEV_USERNAME,
      can_edit: true,
      created_at: '2026-06-05T15:30:00Z',
      updated_at: '2026-06-05T15:30:00Z',
      latest_schedule_solve: null,
      events: [
        {
          // The seed's one **ready-to-start** event, and the reason this tournament has
          // one at all (it used to have none): going live now has a precondition
          // (ADR-0786) — at least one event, every event drawn, every draw still seating
          // exactly its entrants — so a seed in which *nothing* satisfied it would make
          // `live` and `archived` unreachable in `npm run dev` and in the store's own
          // tests, and would leave the whole precondition unexercised on its happy path.
          //
          // Round-robin with groups and a draw cut from its own entrants, so it is
          // `current` by the same set-comparison the server makes. Publish this
          // tournament and Start works; publish the Bay Area Open — four of whose five
          // events have no draw — and Start is refused, by name. The seed holds both.
          id: 'ev-slam-open',
          tournament_id: SUMMER_SLAM_ID,
          name: 'Slam Open Singles',
          format: 'singles',
          draw_type: 'round-robin',
          stages: mintStageReads('round-robin'),
          qualifiers_per_group: null,
          rounds: null,
          max_players: 16,
          entry_fee: 20,
          timezone: 'America/New_York',
          entrants: otherEntrants('ev-slam-open', 8),
          slot: { date: '2026-08-22', start: '09:00', end: '13:00' },
          match_settings: { rated: true, length_games: 5 },
          predicates: [],
          reservations: SLAM_RESERVATIONS,
          fixtures: planRoundRobinFixtures(
            otherEntrants('ev-slam-open', 8).map((e) => e.id),
            SLAM_RESERVATIONS.map((r) => groupIdFor(r.id)),
          ),
          // Drawn but unplayed — go-live materializes its fixtures into matches, but no
          // result has landed, so there is nothing to stand yet (ADR-0788).
          results: null,
          created_at: '2026-06-05T15:31:00Z',
          updated_at: '2026-06-05T15:31:00Z',
        },
      ],
    },
    {
      id: CLUB_CHAMPS_ID,
      name: 'Club Championship',
      description: 'Run by the league office — view only.',
      // `published`, not `live`: registration is open only while a tournament is
      // published (ADR-0017), and this is the seed's ONLY row the dev user does
      // not own — so it is the only place `npm run dev` can show that entering is
      // gated on the `tournament.enter` permission and NOT on ownership. Seeding
      // it `live` would lock its entries and hide that. The closed-window states
      // are still one click away: start (then end) the owned Bay Area Open.
      status: 'published',
      start_date: '2026-07-01',
      end_date: '2026-07-01',
      league_id: DEFAULT_LEAGUE_ID,
      address: {
        venue: 'San Jose Sports Hall',
        street: '1500 Senter Rd',
        city: 'San Jose',
        region: 'CA',
        postal: '95112',
        country: 'USA',
        latitude: 37.3382,
        longitude: -121.8863,
      },
      table_catalogue: tables(10),
      created_by_user_id: 'u-office',
      created_by_username: 'league.office',
      can_edit: false,
      created_at: '2026-05-20T10:00:00Z',
      updated_at: '2026-06-12T08:00:00Z',
      latest_schedule_solve: null,
      events: [
        {
          // On a tournament the dev user does NOT own (but which IS published):
          // entering is gated on the `tournament.enter` permission, not on
          // ownership, so Enter still shows.
          id: 'ev-cc-open',
          tournament_id: CLUB_CHAMPS_ID,
          name: "Women's Championship Singles",
          format: 'singles',
          draw_type: 'single-elim',
          stages: mintStageReads('single-elim'),
          qualifiers_per_group: null,
          rounds: null,
          max_players: 32,
          entry_fee: 40,
          timezone: 'America/Los_Angeles',
          entrants: otherEntrants('ev-cc-open', 28),
          slot: { date: '2026-07-01', start: '17:00', end: '21:00' },
          match_settings: { rated: true, length_games: 5 },
          // The only non-owned row in the seed, so it is the only place the
          // read-only event panel can be seen in `npm run dev`. The two rules
          // cover both branches of the read-only prose: a plain numeric
          // comparison ("Rating is at least 1200") and a `between` (a
          // two-element value array — "Rating is between 1200 and 2400").
          //
          // `rating` is the whole vocabulary now (ADR-0783): the club / age /
          // gender rules that used to seed the bool and enum branches named
          // player attributes that exist nowhere in the system, and the API
          // 422s them.
          predicates: [
            { id: 'pr-cc-2', field: 'rating', op: '>=', value: 1200 },
            { id: 'pr-cc-3', field: 'rating', op: 'between', value: [1200, 2400] },
          ],
          // ONE reservation (#1482): a `single-elim` event holds at most one, so every
          // table the three former reservations covered ("Group A", "Group B",
          // "Knockout" — a shape from before this cap) is now in it, spanning the
          // whole window. Nothing reads this event's reservations (foreign-tournament
          // tests aside), so the collapse costs no coverage.
          reservations: [
            {
              id: 'p-cc-1',
              name: 'Reservation A',
              slot: { date: '2026-07-01', start: '17:00', end: '21:00' },
              table_ids: ['t1', 't2', 't3', 't4', 't5', 't6'],
              position: 0,
            },
          ],
          // Un-drawn, and it stays that way through the UI: the dev user does not own
          // this tournament, and cutting a draw is owner-only (`cutDraw` 403s them).
          fixtures: [],
          results: null,
          created_at: '2026-05-20T10:05:00Z',
          updated_at: '2026-06-12T08:00:00Z',
        },
      ],
    },
    {
      // A tournament with NO VENUE — `address: null` (CONTEXT.md, "Venue").
      //
      // It is seeded, and seeded PUBLISHED, because this is a first-class state at
      // every status and not an edge case: it is a small tournament in somebody's
      // home, whose address is deliberately withheld, and it is equally the shape of
      // an announced tournament whose room is not booked yet. `npm run dev` has to
      // be able to show one — the header with no venue row and no map — or the rule
      // ("a tournament with no venue renders NOTHING, never a placeholder") is a
      // rule nobody can look at.
      //
      // It is also the store's proof that a venue-less row is dropped from a near-me
      // search at ANY radius: with only venued rows in the seed, `listTournaments`
      // could default a missing address to (0, 0) and every radius test would still
      // pass.
      //
      // Owned by the dev user, so the Details tab opens editable and the six empty
      // venue boxes are reachable.
      id: GARAGE_INVITATIONAL_ID,
      name: 'Garage Invitational',
      description: 'Address shared with entrants after registration.',
      status: 'published',
      start_date: '2026-09-12',
      end_date: '2026-09-12',
      league_id: DEFAULT_LEAGUE_ID,
      address: null,
      table_catalogue: tables(2),
      created_by_user_id: DEV_USER_ID,
      created_by_username: DEV_USERNAME,
      can_edit: true,
      created_at: '2026-06-13T18:00:00Z',
      updated_at: '2026-06-13T18:00:00Z',
      latest_schedule_solve: null,
      events: [
        {
          id: 'ev-garage-open',
          tournament_id: GARAGE_INVITATIONAL_ID,
          name: 'Garage Singles',
          format: 'singles',
          draw_type: 'round-robin',
          stages: mintStageReads('round-robin'),
          qualifiers_per_group: null,
          rounds: null,
          max_players: 8,
          entry_fee: 0,
          timezone: 'America/Los_Angeles',
          entrants: otherEntrants('ev-garage-open', 3),
          slot: { date: '2026-09-12', start: '13:00', end: '17:00' },
          match_settings: { rated: false, length_games: 3 },
          predicates: [],
          reservations: [],
          fixtures: [],
          results: null,
          created_at: '2026-06-13T18:01:00Z',
          updated_at: '2026-06-13T18:01:00Z',
        },
      ],
    },
    {
      // The seed's **two-stage** tournament (ADR 20260727) — and its only `live` one.
      //
      // Both of its events are `rr-then-ko`, and between them they hold the two states
      // the results union's third arm (`kind: "standings_then_finishes"`) has: the
      // Challenge Cup finished on the Saturday and has a champion; the Shield's groups
      // are decided and its final is still to be played. Everything they are built from
      // — the groups, the play, the brackets, and why the champion is who it is — is in
      // the block above `seed()`.
      //
      // It is Los Angeles, ~345 miles from Berkeley, on purpose: every near-me test in
      // the suite searches around Berkeley at 10 or 35 miles, so a venue placed anywhere
      // in the Bay would silently join their expected result sets.
      id: GOLDEN_STATE_ID,
      name: 'Golden State Classic 2026',
      description: 'Groups on the Saturday, knockout on the Sunday.',
      status: 'live',
      start_date: '2026-06-06',
      end_date: '2026-06-07',
      league_id: DEFAULT_LEAGUE_ID,
      address: {
        venue: 'Golden State TT Center',
        street: '3900 W Sixth St',
        city: 'Los Angeles',
        region: 'CA',
        postal: '90020',
        country: 'USA',
        latitude: 34.0522,
        longitude: -118.2437,
      },
      table_catalogue: tables(8),
      created_by_user_id: DEV_USER_ID,
      created_by_username: DEV_USERNAME,
      can_edit: true,
      created_at: '2026-05-02T10:00:00Z',
      updated_at: '2026-06-07T11:20:00Z',
      latest_schedule_solve: null,
      events: [
        {
          // FINISHED: both groups decided, the bracket run to a final, a champion crowned.
          //
          // FULL (8 of 8), deliberately: a finished event must not offer the dev user an
          // Enter button, and an entry would make its draw *stale* — a decided event
          // whose draw no longer seats its field is a state the server could never be in.
          id: CUP_EVENT_ID,
          tournament_id: GOLDEN_STATE_ID,
          name: 'Challenge Cup',
          format: 'singles',
          draw_type: 'rr-then-ko',
          // TWO stages — `mintStageReads('rr-then-ko')` mints `'s-1'` (round-robin, the
          // groups below) then `'s-2'` (single-elim, the knockout fixtures below), the
          // ids `CUP_KNOCKOUT_FIXTURES` and the group-stage plan below both name.
          stages: mintStageReads('rr-then-ko'),
          // TWO qualifiers per group — the number that sizes the bracket at the cut
          // (`P × K` = 2 × 2 = 4, derived and never configured, ADR 20260727). Unlike
          // every other event in this seed it is NOT null: a knockout stage to qualify
          // for is exactly what this draw type has.
          qualifiers_per_group: 2,
          rounds: null,
          max_players: 8,
          entry_fee: 35,
          timezone: 'America/Los_Angeles',
          entrants: otherEntrants(CUP_EVENT_ID, 8),
          slot: { date: '2026-06-06', start: '09:00', end: '16:00' },
          match_settings: { rated: true, length_games: 3 },
          predicates: [],
          reservations: CUP_RESERVATIONS,
          // BOTH STAGES, in the order the wire sends them: the group fixtures planned by
          // the same function `cutDraw` uses — then stamped with the winners they were
          // actually played to — followed by the knockout bracket, seated and decided.
          // `tournaments-store.test.ts` asserts this whole list has the shape
          // `planDraw('rr-then-ko', …)` cuts for this very field, so it is that draw
          // played out rather than a hand-drawn one no cut would produce.
          fixtures: [
            ...stampGroupWinners(
              planRoundRobinFixtures(
                CUP_ENTRY_IDS,
                CUP_RESERVATIONS.map((r) => groupIdFor(r.id)),
              ),
              CUP_GROUP_WINNERS,
            ),
            ...CUP_KNOCKOUT_FIXTURES,
          ],
          // The third arm of the results union (ADR 20260727), tagged
          // `standings_then_finishes`: ONE standings block per group and ONE finishes
          // block for the bracket — the very models the round-robin and single-elim arms
          // send, so each stage renders with the panel that already exists.
          //
          // `complete: true` is BOTH stages decided, not either: every group says
          // `complete`, and the bracket has run to a final. `champion` is that final's
          // winner (`player.2`) — and `player.2` tops NO group, which is the whole point.
          // Topping a group wins nothing here; the group stage only seeds the bracket.
          results: {
            kind: 'standings_then_finishes',
            complete: true,
            champion: cup(2),
            groups: [
              {
                group_id: groupIdFor(CUP_RESERVATIONS[0].id),
                complete: true,
                rows: [
                  { entry_id: cup(5), rank: 1, played: 3, wins: 3, losses: 0, games_won: 6, games_lost: 1, game_difference: 5 },
                  { entry_id: cup(1), rank: 2, played: 3, wins: 2, losses: 1, games_won: 5, games_lost: 2, game_difference: 3 },
                  { entry_id: cup(4), rank: 3, played: 3, wins: 1, losses: 2, games_won: 2, games_lost: 5, game_difference: -3 },
                  { entry_id: cup(8), rank: 4, played: 3, wins: 0, losses: 3, games_won: 1, games_lost: 6, game_difference: -5 },
                ],
              },
              {
                // Both of this group's ties are broken by two-way head-to-head, so the
                // rank column is NOT a re-reading of the wins column: `player.3` and
                // `player.2` both went 2–1, and `player.3` won the match between them.
                group_id: groupIdFor(CUP_RESERVATIONS[1].id),
                complete: true,
                rows: [
                  { entry_id: cup(3), rank: 1, played: 3, wins: 2, losses: 1, games_won: 5, games_lost: 3, game_difference: 2 },
                  { entry_id: cup(2), rank: 2, played: 3, wins: 2, losses: 1, games_won: 4, games_lost: 4, game_difference: 0 },
                  { entry_id: cup(6), rank: 3, played: 3, wins: 1, losses: 2, games_won: 4, games_lost: 4, game_difference: 0 },
                  { entry_id: cup(7), rank: 4, played: 3, wins: 1, losses: 2, games_won: 3, games_lost: 5, game_difference: -2 },
                ],
              },
            ],
            // Single-elimination's own placement shape (`2 ** (final_round − round) + 1`):
            // 1st, 2nd, then the two semifinal losers **tied 3rd** — same round out, same
            // position, because the bracket never played them off. Those two losers are
            // the group winners.
            finishes: [
              { entry_id: cup(2), position: 1, eliminated_in_round: null },
              { entry_id: cup(1), position: 2, eliminated_in_round: 2 },
              { entry_id: cup(5), position: 3, eliminated_in_round: 1 },
              { entry_id: cup(3), position: 3, eliminated_in_round: 1 },
            ],
          },
          created_at: '2026-05-02T10:05:00Z',
          updated_at: '2026-06-06T17:12:00Z',
        },
        {
          // MID-FLIGHT: the same shape, one round from home. Every group is decided and
          // the final is seated and unplayed, so `complete` is false, `champion` is null,
          // and `finishes` holds only what the bracket has actually settled.
          id: SHIELD_EVENT_ID,
          tournament_id: GOLDEN_STATE_ID,
          name: 'Shield Singles',
          format: 'singles',
          draw_type: 'rr-then-ko',
          // TWO stages, the same convention the Cup uses above — `'s-1'`/`'s-2'`.
          stages: mintStageReads('rr-then-ko'),
          // Two groups of three, two qualifiers from each — `K = ⌊N/P⌋`, the legal
          // maximum, where everyone but the group's last qualifies and the group stage
          // exists purely to seed (ADR 20260727).
          qualifiers_per_group: 2,
          rounds: null,
          max_players: 6,
          entry_fee: 25,
          timezone: 'America/Los_Angeles',
          entrants: otherEntrants(SHIELD_EVENT_ID, 6),
          slot: { date: '2026-06-07', start: '09:00', end: '16:00' },
          match_settings: { rated: true, length_games: 3 },
          predicates: [],
          reservations: SHIELD_RESERVATIONS,
          fixtures: [
            ...stampGroupWinners(
              planRoundRobinFixtures(
                SHIELD_ENTRY_IDS,
                SHIELD_RESERVATIONS.map((r) => groupIdFor(r.id)),
              ),
              SHIELD_GROUP_WINNERS,
            ),
            ...SHIELD_KNOCKOUT_FIXTURES,
          ],
          // The PARTIAL two-stage read. Note what is and is not true of it: both groups
          // say `complete`, and the event still does not — `complete` is *both* stages
          // decided, and one final stands between this event and its champion. The
          // finishes list therefore starts at position **3**: the two beaten
          // semifinalists are the only entrants the bracket has placed, and 1st and 2nd
          // do not exist yet.
          results: {
            kind: 'standings_then_finishes',
            complete: false,
            champion: null,
            groups: [
              {
                // A THREE-way tie — everyone 1–1 — which two-way head-to-head cannot
                // break, so the order is game difference: +1, 0, −1.
                group_id: groupIdFor(SHIELD_RESERVATIONS[0].id),
                complete: true,
                rows: [
                  { entry_id: shield(1), rank: 1, played: 2, wins: 1, losses: 1, games_won: 3, games_lost: 2, game_difference: 1 },
                  { entry_id: shield(5), rank: 2, played: 2, wins: 1, losses: 1, games_won: 3, games_lost: 3, game_difference: 0 },
                  { entry_id: shield(4), rank: 3, played: 2, wins: 1, losses: 1, games_won: 2, games_lost: 3, game_difference: -1 },
                ],
              },
              {
                group_id: groupIdFor(SHIELD_RESERVATIONS[1].id),
                complete: true,
                rows: [
                  { entry_id: shield(2), rank: 1, played: 2, wins: 2, losses: 0, games_won: 4, games_lost: 1, game_difference: 3 },
                  { entry_id: shield(3), rank: 2, played: 2, wins: 1, losses: 1, games_won: 3, games_lost: 2, game_difference: 1 },
                  { entry_id: shield(6), rank: 3, played: 2, wins: 0, losses: 2, games_won: 0, games_lost: 4, game_difference: -4 },
                ],
              },
            ],
            finishes: [
              { entry_id: shield(3), position: 3, eliminated_in_round: 1 },
              { entry_id: shield(2), position: 3, eliminated_in_round: 1 },
            ],
          },
          created_at: '2026-05-02T10:06:00Z',
          updated_at: '2026-06-07T11:20:00Z',
        },
      ],
    },
    {
      // Somebody else's DRAFT — the one row in the seed that is never served.
      //
      // The store is the database, not the route: the API's table really does hold
      // other organisers' unpublished drafts, and what keeps them off the dev user's
      // wire is the visibility predicate in `listTournaments` / `findTournament`
      // below (#967), not their absence from the table. So the row is seeded
      // precisely so that the predicate has something to hide: without it, the
      // predicate would be unexercised in `npm run dev` and unreachable from the
      // store's own tests, which is how a filter quietly rots into a no-op.
      //
      // Its observable behaviour is the API's: absent from the list, and a 404 —
      // not a 403 — from the detail route, because a draft you cannot see must be
      // indistinguishable from one that does not exist.
      id: LEAGUE_OFFICE_DRAFT_ID,
      league_id: DEFAULT_LEAGUE_ID,
      name: 'League Office Draft 2027',
      description: 'Not announced yet — and not the dev user’s to see.',
      status: 'draft',
      start_date: '2027-01-16',
      end_date: '2027-01-17',
      address: {
        venue: 'San Jose Sports Hall',
        street: '1500 Senter Rd',
        city: 'San Jose',
        region: 'CA',
        postal: '95112',
        country: 'USA',
        latitude: 37.3382,
        longitude: -121.8863,
      },
      table_catalogue: tables(6),
      created_by_user_id: 'u-office',
      created_by_username: 'league.office',
      can_edit: false,
      created_at: '2026-06-14T11:00:00Z',
      updated_at: '2026-06-14T11:00:00Z',
      latest_schedule_solve: null,
      events: [],
    },
  ]
}

let tournaments: StoredTournament[] = seed()

/** What this event has to say about the DEV USER entering it (ADR-0783), in the
 * server's own precedence: **eligibility before capacity**. A player whose rating
 * fails a rule is told so even when the event is also full — being told "it's
 * full" would invite them back when a place frees up, and no place that frees up
 * will ever be theirs.
 *
 * The capacity arm is derived from the entrants (`entryStateFor`), so entering the
 * last free place flips the event to `event_full` on the very next read — a stored
 * tag could not, and the dev demo would keep offering Enter on a full event. */
function entryState(event: StoredEvent): TournamentEventRead['entry_state'] {
  if (event.ineligible) {
    return {
      state: 'rating_ineligible',
      predicate_id: event.ineligible.predicate_id,
      rating: event.ineligible.rating,
    }
  }
  return entryStateFor(event)
}

/** Project a stored event onto the wire shape, deriving the `entered` count from
 * the entrants — the one place the count comes from — the caller-aware `entry_state`
 * from the entrants and the seeded rating verdict, and `groups` from the event's own
 * stages and reservations (`groupsForEvent`, ADR 20260823 — every stage holds its own
 * groups, decoupled from the reservation count except for an `rr-then-ko` event's
 * group stage, which keeps deriving from `reservations.length` as it always has). */
function readEvent(event: StoredEvent): TournamentEventRead {
  const { ineligible, ...wire } = event
  void ineligible
  return {
    ...wire,
    groups: groupsForEvent(event),
    entered: event.entrants.length,
    entry_state: entryState(event),
  }
}

function readDetail(t: StoredTournament): TournamentDetailRead {
  // `distance_miles` is a property of a *near-me* read, not of the tournament: the
  // default list and every detail read carry `null` (no location was asked about),
  // exactly as the server sends it. `listTournaments` overwrites it for the rows a
  // near-me query keeps.
  return {
    ...t,
    events: t.events.map(readEvent),
    distance_miles: null,
    // The served draw-type catalogue — every draw type the server can actually run, with
    // the copy to render it by (ADR "a draw type is a seeded row"). Non-null on DETAIL,
    // because this is the page that picks one.
    draw_type_catalogue: DRAW_TYPE_CATALOGUE,
  }
}

/** One row of the LIST, which is the detail shape with the catalogue withheld.
 *
 * `null`, not the catalogue and not an empty array: the list route genuinely sends
 * `draw_type_catalogue: null` (`api/app/tournament_list.py`), because a catalogue is page
 * data for the one page that picks a draw type and repeating it on every row of a list
 * would be the BFF paying for it N times. `[]` would be a lie of a different kind — "the
 * server can run no draw types at all" — so the absence has to be spelled as absence. */
function readListRow(t: StoredTournament): TournamentDetailRead {
  return { ...readDetail(t), draw_type_catalogue: null }
}

// ----- near-me filtering (mirrors the API's haversine) ---------------------
//
// The list can be scoped to tournaments **near a point** (the all-or-nothing
// `lat`/`lng`/`radius_miles` triple): only venues within `radius_miles` come back, each
// carrying its `distance_miles`. The store computes that distance the way the server does
// — a haversine over the coords each address already stores (`geocodeAddress`) — so
// `npm run dev` and vitest exercise real filtering with no backend behind them.

/** A location + radius the list is scoped to — the same shape the app-side list query
 * carries (`TournamentsNearMe`), aliased here under the mock's name so the store and the
 * app share one definition. All three fields or none: the handler enforces the
 * all-or-nothing contract at the boundary, so a filter that reaches here is complete. */
export type NearMeFilter = TournamentsNearMe

/** Earth's mean radius in miles — the SAME constant the API's haversine uses, so a mock
 * `distance_miles` rounds to the value the real server would send. */
const EARTH_RADIUS_MILES = 3958.8

const toRadians = (deg: number): number => (deg * Math.PI) / 180

/** Great-circle distance in miles between two `(lat, lng)` points, rounded to one decimal
 * — the API's `distance_miles` precision. Mirrors the server's haversine so a mock card
 * shows the distance the real card would. */
function haversineMiles(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const dLat = toRadians(bLat - aLat)
  const dLng = toRadians(bLng - aLng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(aLat)) *
      Math.cos(toRadians(bLat)) *
      Math.sin(dLng / 2) ** 2
  const miles = 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h))
  return Math.round(miles * 10) / 10
}

/** Reset the store to its seed — used by the dev worker bootstrap if needed, and
 * by tests that drive the store through the default handlers. */
export function resetTournamentsStore() {
  tournaments = seed()
}

// The statuses in which a tournament has been ANNOUNCED to the world — the mock's
// copy of the server's `ANNOUNCED_STATUSES` (`api/app/tournaments.py`, #967).
// Publishing is the act that makes a tournament public (ADR-0017) and nothing walks
// backwards out of it, so everything from `published` onward is announced and
// `draft` is not.
//
// An allow-list, deliberately — NOT `status !== 'draft'`. A status added to
// `TournamentStatus` tomorrow is invisible to non-owners until somebody puts it in
// this set on purpose; the inverse spelling would silently publish a future
// pre-publish status (a `pending_review`, a `scheduled`) the moment it was added,
// which is the very leak the predicate exists to close. Spelled as a `Record` over
// the enum rather than a bare `Set<string>`, so that new status is a *type error*
// here — an unlisted key cannot simply be forgotten.
const ANNOUNCED: Record<TournamentStatus, boolean> = {
  draft: false,
  published: true,
  live: true,
  archived: true,
}

/** The same allow-list as a list, for the callers that need to *iterate* the
 * announced statuses rather than ask about one — today the web-client e2e suite,
 * whose viewer sweeps must run over exactly the statuses a non-owner can ever have
 * on screen.
 *
 * DERIVED, never re-typed. A hand-written second copy of these three strings is
 * unchecked by the type system and rots silently: the day a status is added,
 * `ANNOUNCED` above is a compile error (good) while a literal `['published',
 * 'live', 'archived']` elsewhere just keeps passing, and the sweep that thought it
 * covered every announced status quietly covers all but the new one. */
export const ANNOUNCED_STATUSES: readonly TournamentStatus[] = (
  Object.keys(ANNOUNCED) as TournamentStatus[]
).filter((s) => ANNOUNCED[s])

/** Which tournaments the dev user may see AT ALL: the announced ones, plus their
 * own — whatever status their own is in (`_visible_to`, `api/app/tournaments.py`).
 *
 * Ownership is matched on `created_by_user_id`, the server's spelling, rather than
 * on the derived `can_edit` flag that happens to agree with it: the id is the fact,
 * `can_edit` is a projection of it.
 *
 * One predicate for both reads below, for the server's reason: two copies of this
 * rule would eventually disagree, and the way they disagree is that the list hides
 * a draft the detail route still serves. */
function isVisible(t: StoredTournament): boolean {
  return ANNOUNCED[t.status] || t.created_by_user_id === DEV_USER_ID
}

/** The list, newest-created first (mirrors the API's ordering) — and scoped to what
 * the dev user may see: another organiser's draft never appears.
 *
 * Pass `nearMe` to scope it to venues **within the radius of a point**: each surviving
 * row carries its `distance_miles` (a haversine from that point to its venue), and the
 * ones outside the radius are dropped — the server's near-me contract. Omit it and every
 * visible tournament comes back with `distance_miles` null (via `readDetail`). */
export function listTournaments(nearMe?: NearMeFilter): TournamentDetailRead[] {
  const visible = tournaments
    .filter(isVisible)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map(readListRow)
  if (!nearMe) return visible
  return (
    visible
      // A tournament with NO VENUE is never a proximity-search result, at any radius
      // — there is nothing to measure to (CONTEXT.md, "Venue"). The server drops it
      // the same way: its haversine is computed in SQL over the address JSONB's
      // coordinates, and a NULL address yields no distance, so the row never
      // survives the `<= radius` comparison. Mirrored here rather than defaulted to
      // (0, 0), which would place every venue-less tournament off the coast of
      // Africa and make it "near" anyone searching from there.
      .flatMap((t) => {
        const address = t.address
        if (address === null) return []
        return [
          {
            ...t,
            distance_miles: haversineMiles(
              nearMe.lat,
              nearMe.lng,
              address.latitude,
              address.longitude,
            ),
          },
        ]
      })
      .filter((t) => t.distance_miles <= nearMe.radiusMiles)
  )
}

/** A single tournament's detail, or `undefined` if it is missing **or hidden**.
 *
 * The two answers are deliberately the same one, as on the server: a tournament the
 * caller cannot see is simply not found, so it leaves through the handler's existing
 * 404 by the one path a nonexistent id already takes. A 403 would confirm that a
 * tournament with that id exists — precisely what an unannounced draft must not
 * admit — so there is no second branch here to get wrong. (The owner-only *writes*
 * still 403 via `requireOwned`: those are all on rows the caller can see.) */
export function findTournament(id: string): TournamentDetailRead | undefined {
  const found = tournaments.find((t) => t.id === id)
  if (found === undefined || !isVisible(found)) return undefined
  // Walk any in-flight schedule solve forward (see `tickScheduleSolve`): the mock
  // has no worker, so the detail read — the one the Schedule tab polls — is what
  // advances queued → running → succeeded and lands the placements.
  const ticked = tickScheduleSolve(found)
  if (ticked !== found) replace(ticked)
  return readDetail(ticked)
}

let createCounter = 0

/** A brand-new tournament's id — the mock's `gen_random_uuid()`.
 *
 * UUID-shaped (`mockUuid`, #1229) because the wire says so (`Tournament.id` is
 * `format: uuid`) and because the `$tournamentId` route Zod-validates the segment as
 * one BEFORE any fetch (ADR-1001): a slug id here would make the tournament this very
 * call just created 404 on its own detail page the moment `NewTournamentModal`
 * navigates to it. Keyed on a slug of the name PLUS a counter, not the name alone, so
 * two tournaments created with the same name (nothing stops a director from doing
 * that) still get distinct ids — the counter deliberately does NOT reset with the
 * store, for the same reason `mintTable`'s doesn't. */
function mintTournamentId(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'tournament'
  createCounter += 1
  return mockUuid(`tournament:${base}-${createCounter}`)
}

/** Create a bare tournament owned by the dev user (so it's editable). Returns
 * the `TournamentRead` (no events — create makes a bare tournament).
 *
 * It is born `draft`, unconditionally: `TournamentCreate` has no `status` to ask
 * for one (ADR-0017), so this mirrors the server's column default. */
/** Stand in for the server's write-time geocoding: a client sends the six-field
 * coordinate-free `AddressInput`, and the server derives and stores the read
 * `Address` (with `latitude`/`longitude`, NOT NULL). The store can't geocode, so
 * it stamps a fixed Bay-Area coordinate — enough to satisfy the read contract
 * every reader now depends on. */
function geocodeAddress(input: AddressInput): Address {
  return { ...input, latitude: 37.8715, longitude: -122.273 }
}

/** The venue a write payload actually submitted — the mock's `SubmittedAddress`
 * (`api/app/schemas/tournament.py`).
 *
 * `null`/absent is no venue, and so is an object whose six components are **all
 * blank**: the server normalizes that to `None` at its own boundary, before the
 * geocoder ever sees it, because six empty boxes are not an address. The mock
 * normalizes identically, so a form that clears its venue fields removes the venue
 * in `npm run dev` exactly as it does in production — rather than storing a blank
 * address the store would then hand the geocoder and pin in Berkeley.
 *
 * The blankness test is `hasVenue` — the app's own, not a copy of it. The mock does
 * restate several server behaviours in TypeScript on purpose (the near-me exclusion
 * mirrors SQL semantics that have no TS equivalent; the `undefined`-vs-`null` PATCH
 * branch mirrors a wire contract), but this is not one of them: "is any component
 * non-blank" is a sweep over the six components, and the shared helper derives that
 * sweep from a type-checked exhaustive literal (`BLANK_ADDRESS_TEXT`). A hand-listed
 * copy here would be a seventh-component blind spot that no compiler could see, in
 * the very code whose job is to catch that mistake before production does. */
function submittedAddress(
  input: AddressInput | null | undefined,
): Address | null {
  if (!input) return null
  if (!hasVenue(input)) return null
  return geocodeAddress(input)
}

// ----- the venue catalogue: server-minted ids, and an id-keyed diff -------------
//
// A table is a ROW now (ADR 20260801, `api/app/tournament_tables.py`), and its id is
// **the server's to mint** — `TournamentTableWrite` (create) has no `id` at all, and
// `TournamentTableUpsert` (patch) has an optional one that *cites* a table rather than
// authoring it. So this store mints too: a catalogue entry that arrives without an id
// is a new table and gets one here, exactly as `gen_random_uuid()` gives it one there.
//
// And the patch is a **diff**, not an assignment: an entry citing an id keeps that
// table (re-worded, re-positioned), an entry with no id adds one, and a stored table no
// entry cites is REMOVED. Keying on the id is what makes a reorder move tables instead
// of swapping labels between ids — the by-position read this replaces did the latter
// silently. The removal is where the two refusals live; see `applyTableCatalogue`.

let tableCounter = 0

/** A brand-new catalogue row for an entry that carries no `id` — the mock's
 * `gen_random_uuid()`.
 *
 * UUID-shaped (`mockUuid`) because the wire says so (`TournamentTable.id` is
 * `format: uuid`), and counter-derived rather than label-derived because two tables may
 * legitimately share a label across tournaments — and two rows sharing an id is the one
 * thing an id-keyed diff cannot survive. The counter deliberately does NOT reset with
 * the store: a fresh seed re-creates the seeded rows, and an id minted for a *previous*
 * test's table must never be handed out again. */
function mintTable(entry: TournamentTableWrite): TournamentTable {
  tableCounter += 1
  return {
    id: mockUuid(`tournament-table-${tableCounter}`),
    label: entry.label,
    court: entry.court,
  }
}

/** The server's sentence for a catalogue edit that would remove a table matches are
 * placed at (`_tables_in_use_detail`, `api/app/tournament_tables.py`) — **verbatim**,
 * because the client shows it verbatim.
 *
 * Names the tables by **label**, never by id (an id tells a director looking at a page
 * of named tables nothing to act on), and names both ways out: send the same edit again
 * with the opt-in and accept the unplacing, or move the matches off the table first. */
function tablesInUseDetail(labels: string[], placements: number): string {
  const one = labels.length === 1
  const has = one ? 'has' : 'have'
  const it = one ? 'it' : 'them'
  const theTable = one ? 'the table' : 'them'
  const matches = placements === 1 ? 'match' : 'matches'
  return (
    `${namedList(labels)} ${has} ${placements} ${matches} placed at ${it}, so ` +
    `removing ${it} from the catalogue would leave those matches with no table — ` +
    'indistinguishable from matches nobody ever placed. To remove ' +
    `${it} anyway, send the same edit again with ` +
    '“unplace_fixtures_on_removed_tables”: true, and those matches lose their ' +
    'table, their time and their call and go back to the schedule to be placed ' +
    `again. To keep them where they are, leave ${theTable} in the catalogue and ` +
    `move the matches off ${it} first.`
  )
}

/** The server's message for an entry citing an id this tournament's catalogue does not
 * hold (`TableNotInCatalogueError`, `api/app/tournament_errors.py`) — a **422 on that
 * entry's `id`**, never a silently minted table: quietly handing the client a different
 * id than it asked for would *also* remove the table it meant to keep, which are the two
 * failures a diff must never confuse. */
const TABLE_NOT_IN_CATALOGUE =
  "This tournament's venue catalogue has no table with that id."

/** What the diff did — the new catalogue and the (possibly unplaced) events — or the
 * refusal that stopped it before a single row moved. */
type CatalogueResult =
  | { ok: true; tables: TournamentTable[]; events: StoredEvent[] }
  | { ok: false; status: 409; detail: string }
  | { ok: false; status: 422; index: number; tableId: string; detail: string }

/** Apply a submitted catalogue to `stored` as an id-keyed diff
 * (`apply_table_catalogue`, `api/app/tournament_tables.py`), judging both refusals
 * **before** anything changes so a refused edit leaves the tournament byte-identical.
 *
 * The asymmetry between a reservation and a placement is the ADR's whole point, and it is
 * mirrored here rather than smoothed over. A table a **reservation** merely holds is
 * removed with no ceremony — a reservation's `table_ids` ARE the hold, and the
 * reservation simply holds one fewer (the stored ids still list the dead one; pruning
 * them is a later slice, on the server too). A table a fixture is **placed at** is
 * refused, because
 * clearing a placement destroys information on an unrelated write: the fixture stops
 * being "placed at a table that vanished" and becomes indistinguishable from "nobody
 * ever placed this".
 *
 * With `unplace` the removal goes through and all THREE placement columns go together —
 * `table_id`, `scheduled_start` and `pinned_at`. A start with no table is a bar on a
 * schedule with nowhere to be, and a pin is a *promise about a table*: leaving either
 * would tell every later solve the fixture is nailed to a table that no longer exists. */
function applyTableCatalogue(
  stored: StoredTournament,
  submitted: TournamentTableUpsert[],
  unplace: boolean,
): CatalogueResult {
  const byId = new Map(stored.table_catalogue.map((t) => [t.id, t]))
  // Judged first, over the whole payload: a catalogue naming a table this tournament
  // does not have is not a catalogue, and every subsequent question (what is kept, and
  // therefore what is removed) would be answered against a list the client did not mean.
  for (const [index, entry] of submitted.entries()) {
    if (entry.id != null && !byId.has(entry.id)) {
      return {
        ok: false,
        status: 422,
        index,
        tableId: entry.id,
        detail: TABLE_NOT_IN_CATALOGUE,
      }
    }
  }

  const kept = new Set(
    submitted.map((entry) => entry.id).filter((id): id is string => id != null),
  )
  const removedIds = new Set(
    stored.table_catalogue.filter((t) => !kept.has(t.id)).map((t) => t.id),
  )
  const placed = stored.events
    .flatMap((event) => event.fixtures)
    .filter((f) => f.table_id !== null && removedIds.has(f.table_id))

  if (placed.length > 0 && !unplace) {
    const blocking = new Set(placed.map((f) => f.table_id))
    const labels = stored.table_catalogue
      .filter((t) => removedIds.has(t.id) && blocking.has(t.id))
      .map((t) => t.label)
    return {
      ok: false,
      status: 409,
      detail: tablesInUseDetail(labels, placed.length),
    }
  }

  const unplacedIds = new Set(placed.map((f) => f.id))
  const events =
    unplacedIds.size === 0
      ? stored.events
      : stored.events.map((event) => ({
          ...event,
          fixtures: event.fixtures.map((f) =>
            unplacedIds.has(f.id)
              ? { ...f, table_id: null, scheduled_start: null, pinned_at: null }
              : f,
          ),
        }))

  return {
    ok: true,
    // The list's ORDER is the catalogue's order — a cited row keeps its id (and every
    // reservation `table_ids` and fixture `table_id` that names it) while taking this
    // payload's words and place; an entry with no id is an insert.
    tables: submitted.map((entry) =>
      entry.id == null
        ? mintTable(entry)
        : { id: entry.id, label: entry.label, court: entry.court },
    ),
    events,
  }
}

export function createTournament(body: TournamentCreate): TournamentRead {
  const now = new Date().toISOString()
  const id = mintTournamentId(body.name)
  const created: StoredTournament = {
    id,
    name: body.name,
    description: body.description ?? null,
    status: 'draft',
    start_date: body.start_date ?? null,
    end_date: body.end_date ?? null,
    // An omitted `league_id` resolves to the default league, exactly as on the
    // server (ADR-0783): the column is NOT NULL, so a created tournament always
    // names the ladder it will be judged on — the caller only says which when it
    // is not the default. No client surface sends one yet.
    league_id: body.league_id ?? DEFAULT_LEAGUE_ID,
    // Omitted, `null`, or all-blank all mean the same thing: a tournament created
    // with NO VENUE (CONTEXT.md, "Venue"), which is a state the server allows at
    // every status and this store must be able to hold.
    address: submittedAddress(body.address),
    // Every table on a create body is a NEW table — `TournamentTableWrite` has no `id`
    // at all — so the store mints one for each, in the order the payload sent them.
    table_catalogue: (body.table_catalogue ?? []).map(mintTable),
    created_by_user_id: DEV_USER_ID,
    created_by_username: DEV_USERNAME,
    can_edit: true,
    created_at: now,
    updated_at: now,
    latest_schedule_solve: null,
    events: [],
  }
  tournaments = [created, ...tournaments]
  return readOf(created)
}

/** A tournament PATCH fails four ways, mirroring the API: 404 (no such tournament),
 * 403 (not the creator), and — both from the table catalogue's id-keyed diff
 * (ADR 20260801) — a **409** when the edit would remove a table matches are placed at
 * without the opt-in, and a **422** naming the entry that cited an id this tournament's
 * catalogue does not hold. The 422 carries the offending entry's `index` so the handler
 * can build the `loc` (`["body", "table_catalogue", i, "id"]`) the real route sends:
 * a catalogue is a list, and a refusal a client cannot attribute to a row is a refusal
 * it cannot render. */
export type StoreResult =
  | { ok: true; tournament: TournamentRead }
  | { ok: false; status: 403 | 404 }
  | { ok: false; status: 409; detail: string }
  | { ok: false; status: 422; index: number; tableId: string; detail: string }

/** An event write fails four ways: 404 (no such tournament/event), 403 (not the
 * creator), a **409** on a PATCH that would move the groups out from under a cut draw
 * (ADR-0786's group-set freeze; see `groupSetFrozenDetail`), and a **422** naming the
 * `reservations` entry that cited an id this event does not have (ADR 20260801's minted
 * ids; see `applyEventReservations`). A create can hit neither: a new event has no draw,
 * and `ReservationWrite` has no id to cite.
 *
 * The 422 carries the offending entry's `index` so the handler can build the `loc`
 * (`["body", "reservations", i, "id"]`) the real route sends — the reservations are a
 * list, and a refusal a client cannot attribute to a row is a refusal it cannot
 * render. */
export type EventResult =
  | { ok: true; event: TournamentEventRead }
  | { ok: false; status: 403 | 404 }
  | { ok: false; status: 409; detail: string }
  | { ok: false; status: 422; index: number; reservationId: string; detail: string }
  // #1482: a non-`rr-then-ko` event would be left holding more than one reservation.
  // Its own arm, discriminated by `reservationCapExceeded` rather than merely by
  // `status: 422` — the shape carries no `index`/`reservationId` at all (the refusal
  // is about the LIST's length against the draw type, not about any one entry), so a
  // handler must tell the two 422s apart before building either body.
  | { ok: false; status: 422; reservationCapExceeded: true; detail: string }

export type DeleteResult = { ok: true } | { ok: false; status: 403 | 404 }

/** A refused entry, in the API's own vocabulary (ADR-0968,
 * `api/app/tournament_entry_refusals.py`): a machine-readable `code` the client
 * switches on, and a `message` it falls back to only for a code it does not know.
 * The mock speaks the same two-part refusal so a test that drives an entry 409
 * exercises the client's *code* path, not a string it will never meet. */
export type EntryRefusalCode =
  | 'already_entered'
  | 'registration_closed'
  // #783's two: the event has no room left, and the caller's rating fails one of
  // its rules. A mock that answered these with a 201 would be MORE permissive than
  // the server it stands in for — and a UI that still offered Enter on a full event
  // would look perfect in `npm run dev`.
  | 'event_full'
  | 'rating_ineligible'

export interface EntryRefusal {
  code: EntryRefusalCode
  message: string
}

/** Entering can fail six ways, mirroring the API: 404 (no such tournament or
 * event), 400 (not a singles event), and a 409 for each of the four refusals —
 * registration closed, already entered, rating-ineligible, event full. Every 409
 * is a coded `EntryRefusal` (ADR-0968) — the shape the route really sends. A 403
 * for a missing `tournament.enter` permission is the session's business, not the
 * store's — the dev session always holds it. */
export type EnterResult =
  | { ok: true; entrant: TournamentEntrantRead }
  | { ok: false; status: 400 | 404 }
  | { ok: false; status: 409; refusal: EntryRefusal }

/** Withdrawing fails with a 403 when the entry is someone else's, and a 409 when
 * the tournament's registration window is shut and the entry is still active.
 * Withdrawing an entry that is already gone is idempotent (`ok`) — in *every*
 * status — as on the server.
 *
 * Its 409 stays a bare `detail` STRING, unlike `enterEvent`'s: ADR-0968 converted
 * the *entry* endpoint's refusals to codes and left the withdraw route's prose
 * alone (#968 stays open against it). The mock is not allowed to be tidier than
 * the server it stands in for. */
export type WithdrawResult =
  | { ok: true }
  | { ok: false; status: 403 | 404 }
  | { ok: false; status: 409; detail: string }

/** Strip the embedded `events` so the create/update handlers return the bare
 * `TournamentRead` the real API does. */
function readOf({ events, ...read }: StoredTournament): TournamentRead {
  void events
  return read
}

/** Swap one tournament in the store for an updated copy. */
function replace(next: StoredTournament) {
  tournaments = tournaments.map((t) => (t.id === next.id ? next : t))
}

/** A tournament the caller is allowed to modify — or the refusal that stopped
 * them. `ok: false` is shaped so every owner-only mutation below can simply
 * `return owned` on the failure path. */
type OwnedResult =
  | { ok: true; tournament: StoredTournament }
  | { ok: false; status: 403 | 404 }

/** Load a tournament and check it is the caller's: the mock's
 * `_get_owned_tournament_or_404` (`api/app/tournaments.py`), which welds the same
 * two questions together for the same reason — every owner-only mutation asks them
 * in the same order: does it exist (**404**), and is it mine (**403**)?
 *
 * The order is load-bearing and is the server's: a stranger must not be able to
 * tell a tournament they cannot touch from one that does not exist at all. Written
 * out six times, one of the six could drift; written once, none can. (Entering and
 * withdrawing do NOT come through here — they are the two mutations a player makes
 * against a tournament they do *not* own, so they check existence only.) */
function requireOwned(id: string): OwnedResult {
  const existing = tournaments.find((t) => t.id === id)
  if (!existing) return { ok: false, status: 404 }
  if (!existing.can_edit) return { ok: false, status: 403 }
  return { ok: true, tournament: existing }
}

/** Patch a tournament's top-level fields. Non-owned rows (`can_edit: false`)
 * return 403; a missing id returns 404 — mirroring the real API's gating.
 *
 * `status` is untouched by design: `TournamentUpdate` has no such field
 * (ADR-0017), so an edit cannot move the lifecycle — only a transition can.
 *
 * A submitted `table_catalogue` is an **id-keyed diff**, with the two refusals
 * `applyTableCatalogue` judges — and both are judged BEFORE anything is written, which
 * is what makes them refusals rather than reports. The refused PATCH's *other* fields
 * (the `name` that rode along on the same request) are not written either: the whole
 * edit is atomic, exactly as it is on the server. */
export function updateTournament(
  id: string,
  patch: TournamentUpdate,
): StoreResult {
  const owned = requireOwned(id)
  if (!owned.ok) return owned
  const existing = owned.tournament
  // The catalogue diff first, and nothing assigned until it answers: a refusal here
  // must leave the tournament byte-identical, `name` included.
  let catalogue = existing.table_catalogue
  let events = existing.events
  if (patch.table_catalogue !== undefined && patch.table_catalogue !== null) {
    const applied = applyTableCatalogue(
      existing,
      patch.table_catalogue,
      // The opt-in's ONE affirmative spelling. Omitted, `false` and `null` are three
      // ways of not saying it and all three mean "not opted in" — the field is
      // `bool | None` on the wire (a non-null default would make it *required* on
      // every PATCH through `openapi-typescript`), so the collapse happens here.
      patch.unplace_fixtures_on_removed_tables === true,
    )
    if (!applied.ok) return applied
    catalogue = applied.tables
    events = applied.events
  }
  const next: StoredTournament = {
    ...existing,
    name: patch.name ?? existing.name,
    description:
      patch.description === undefined ? existing.description : patch.description,
    status: existing.status,
    start_date:
      patch.start_date === undefined ? existing.start_date : patch.start_date,
    end_date: patch.end_date === undefined ? existing.end_date : patch.end_date,
    // OMITTED means unchanged; an explicit `null` — or an all-blank object, which
    // `submittedAddress` normalizes to `null` — means REMOVE the venue. The two are
    // different edits and the server tells them apart (`TournamentUpdate`), so the
    // mock must too: conflating them would make clearing the venue boxes a silent
    // no-op in `npm run dev` while it really removed the venue in production.
    address:
      patch.address === undefined
        ? existing.address
        : submittedAddress(patch.address),
    // OMITTED (or `null`) means unchanged; anything else is the diff computed above —
    // which may have unplaced fixtures, hence `events` moving in the same breath.
    table_catalogue: catalogue,
    events,
    updated_at: new Date().toISOString(),
  }
  replace(next)
  return { ok: true, tournament: readOf(next) }
}

// The tournament lifecycle, in full (ADR-0017):
//
//     draft ──publish──▶ published ──go live──▶ live ──archive──▶ archived
//
// The server's `LEGAL_TRANSITIONS` table, mirrored here as ONE table — legality
// is a property of the (from, to) EDGE, not of the target. Every pair absent
// from it is a 409: backwards, skipping a stage, out of the terminal `archived`,
// and re-asserting the status the tournament already holds (a stale tab must not
// silently succeed). A mock that permitted an illegal edge would let a broken UI
// look fine in dev and in vitest.
const LEGAL_TRANSITIONS: ReadonlySet<string> = new Set([
  'draft>published',
  'published>live',
  'live>archived',
])

/** A transition can fail three ways, in the API's order: 404 (no such
 * tournament), 403 (not the owner), 409 (not a legal edge — or, for go-live, a
 * tournament whose draws are not ready). The 409 carries the server's `detail`
 * verbatim, because the copy is what the director is told. */
export type TransitionResult =
  | { ok: true; tournament: TournamentRead }
  | { ok: false; status: 403 | 404 }
  | { ok: false; status: 409; detail: string }

// ----- the go-live precondition (ADR-0786) ---------------------------------
//
// `published → live` is the one edge with a precondition, and this store enforces it
// exactly as the server does (`_enforce_ready_to_go_live`, `api/app/tournaments.py`).
// A mock that let an empty tournament — or one whose draws were never cut — go live
// would be a mock we could build a *lying UI* against: the button would work in
// `npm run dev` and in vitest, and 409 in front of a director on the morning of their
// tournament. The copy is the server's, verbatim, because the client shows it verbatim.

/** The server's sentence for a tournament with nothing to run. Publishing one is fine —
 * announcing a tournament before its events are written up is ordinary — but starting
 * one is not. Checked FIRST, because "every event has a current draw" is vacuously true
 * of a tournament with no events. */
const NOTHING_TO_START =
  'This tournament has no events, so there is nothing to start. Add an event and cut ' +
  'its draw, then start the tournament.'

/** The things a refusal is about, as a human would say them: `“Group B”`, or
 * `“Group B” and “Group C”` (`named_list`, `api/app/schemas/tournament.py`). */
export function namedList(names: string[]): string {
  return conjoinWithAnd(names.map((name) => `“${name}”`))
}

/** Where one event's draw stands (`DrawCurrency`, `api/app/tournament_draws.py`).
 *
 * A **set comparison, never a count**: currency is "these fixtures seat exactly these
 * entrants". Comparing sizes would pass the same happy-path test and wave through the
 * case that matters most — one player withdraws and another enters between the cut and
 * go-live, leaving the same count, a different field, and a draw that seats somebody who
 * has left while their replacement is seated nowhere.
 *
 * `uncut` is decided on the fixtures EXISTING, not on the seated set being empty: an
 * event nobody has entered has neither, and ∅ == ∅ would call it `current` — an event
 * with no draw at all, certified ready to start. */
function drawCurrency(event: StoredEvent): 'current' | 'uncut' | 'stale' {
  if (event.fixtures.length === 0) return 'uncut'
  const seated = new Set<string>()
  for (const fixture of event.fixtures) {
    // A `null` side is TBD (a KO round whose feeder is undecided), never a bye and never
    // an absent player — so it seats nobody.
    if (fixture.entry_a_id !== null) seated.add(fixture.entry_a_id)
    if (fixture.entry_b_id !== null) seated.add(fixture.entry_b_id)
  }
  const active = event.entrants.map((e) => e.id)
  const same =
    active.length === seated.size && active.every((id) => seated.has(id))
  return same ? 'current' : 'stale'
}

/** Why one at-fault event can never be cut as it stands, or `null` when a cut would
 * actually fix it — the store's mirror of the go-live **dry run** (#1300,
 * `_enforce_ready_to_go_live`).
 *
 * Two judgements, in the server's order:
 *
 * 1. **Format first**, before anything is planned — `cut_draw`'s own ordering. A
 *    doubles/teams event is undrawable on this fact alone, and permanently: entry is
 *    refused for a non-singles event, so its field can never reach two, and the only fix
 *    is removing the event. This arm is local rather than a `planEventDraw` result
 *    because `planDraw` takes no format at all — the cut route judges format ahead of the
 *    strategy, and so does this.
 * 2. **The dry run** — `planEventDraw`, the same planner `cutDraw` uses, planning
 *    fixtures and throwing them away. Its refusal sentence goes through **verbatim**:
 *    only the planner knows which degeneracy it hit, and the numbers in that sentence are
 *    the numbers the director has to change.
 *
 * The fix is appended for a field under two entrants and for nothing else, exactly as the
 * server appends it. Every other degenerate message (no groups, too many qualifiers, too
 * many rounds) already names its own fix inline, so a second one would contradict it. */
function undrawableReason(
  event: StoredEvent,
): { reason: string; fix: string | null } | null {
  if (event.format !== 'singles') {
    return {
      reason:
        `A ${event.format} event cannot be given a draw — only singles events can. ` +
        'A fixture seats one entrant on each side, and there is nowhere to record a ' +
        'doubles pairing or a team.',
      fix: 'Remove the event.',
    }
  }
  const plan = planEventDraw(event)
  if (plan.ok) return null
  return {
    reason: plan.detail,
    fix: event.entrants.length < 2 ? 'Add entrants, or remove the event.' : null,
  }
}

/** One undrawable event's sentence: its name, its own reason, and its own fix. The reason
 * already ends in a period, so the fix is joined with a leading space rather than the
 * sentence gaining a second period (or a trailing space when there is no fix). */
function undrawableSentence(
  name: string,
  reason: string,
  fix: string | null,
): string {
  return `“${name}”: ${reason}` + (fix ? ` ${fix}` : '')
}

/** The "cut the draw" half of the refusal — every `uncut`/`stale` event, plus the trailing
 * instruction. **Byte-identical to what `goLiveRefusal` produced before `undrawable`
 * existed**, which is the regression this shape guarantees for every tournament with no
 * undrawable event in it.
 *
 * The two failures are kept apart in the sentence, because they are two different jobs:
 * an **uncut** event needs a first cut, while a **stale** one has a draw the director may
 * well have reviewed and approved — it is merely older than the field — and needs
 * re-cutting. */
function uncutStaleBody(uncut: string[], stale: string[]): string {
  const clauses: string[] = []
  if (uncut.length > 0) {
    clauses.push(
      `${namedList(uncut)} ${uncut.length === 1 ? 'has' : 'have'} no draw yet`,
    )
  }
  if (stale.length > 0) {
    clauses.push(
      `${namedList(stale)} ${
        stale.length === 1
          ? 'has a draw that no longer matches its entrants'
          : 'have draws that no longer match their entrants'
      }`,
    )
  }
  return (
    clauses.join('; and ') +
    '. A draw is cut from the field as it stands at the time, and registration stays ' +
    'open right up to the moment a tournament goes live — so cut the draw for each ' +
    'event named (again, if somebody entered or withdrew since it was last cut), then ' +
    'start the tournament.'
  )
}

/** Why this tournament cannot start yet, in the server's own words — or `null` when it
 * can. **It names the events**, because a refusal a director cannot act on is barely
 * better than a 500: "some event has no draw" leaves them clicking through a ten-event
 * tournament looking for it.
 *
 * **Two bodies, joined with a space** (#1300), because they answer two different
 * questions:
 *
 * * the `undrawable` body, one sentence per event, for events no cut could ever fix as
 *   they stand: a field under two entrants, or a non-singles event; and
 * * the `uncut`/`stale` body, for events a cut (or a re-cut) would genuinely fix — the
 *   sentence this refusal has always been.
 *
 * **`undrawable` is emitted first, and the order is load-bearing.** The `uncut`/`stale`
 * body ends in "so cut the draw for each event named …, then start the tournament". Put
 * that body first and the undrawable sentences trail *after* the instruction, so "each
 * event named" reads as covering them too — and a director who follows it clicks
 * Generate draw on an event the cut refuses. QA walked exactly that circle.
 *
 * **When every at-fault event is undrawable the `uncut`/`stale` body is absent**, so the
 * refusal never contains the "cut the draw for each event named" instruction. That is the
 * whole defect #1300 closes: telling a director to cut a draw the system will refuse a
 * second time is an instruction they cannot follow, and the only escape the QA pass found
 * was deleting the event.
 *
 * Two lists rather than one appended in place, because the bodies are ordered (undrawable
 * first) while the events inside each keep the tournament's own order — an event listed
 * first can still be reported last. */
function goLiveRefusal(tournament: StoredTournament): string | null {
  if (tournament.events.length === 0) return NOTHING_TO_START

  const undrawable: string[] = []
  const uncut: string[] = []
  const stale: string[] = []
  for (const event of tournament.events) {
    const currency = drawCurrency(event)
    // A current draw is not at fault, and is never dry-run: the cut it already has is
    // the proof that one succeeds.
    if (currency === 'current') continue
    const undrawableFor = undrawableReason(event)
    if (undrawableFor !== null) {
      undrawable.push(
        undrawableSentence(event.name, undrawableFor.reason, undrawableFor.fix),
      )
    } else if (currency === 'uncut') uncut.push(event.name)
    else stale.push(event.name)
  }
  if (undrawable.length === 0 && uncut.length === 0 && stale.length === 0) {
    return null
  }

  // `undrawable` FIRST, mirroring the server. The `uncut`/`stale` body ends in "so cut
  // the draw for each event named …" — trailing the undrawable sentences after that
  // instruction makes "each event named" read as covering them too, and sends the
  // director to a Generate draw the cut refuses (#1300 QA).
  const segments: string[] = []
  if (undrawable.length > 0) segments.push(undrawable.join(' '))
  if (uncut.length > 0 || stale.length > 0) {
    segments.push(uncutStaleBody(uncut, stale))
  }
  return 'This tournament cannot start yet: ' + segments.join(' ')
}

/** Materialize an event's ready fixtures into real matches — the go-live step (#788,
 * `api/app/tournaments.py`). A fixture is **ready** when both its sides are known; a TBD
 * fixture (a null side — a KO round whose feeder is undecided) is not, and is left to be
 * materialized later. Idempotent on `match_id`: a fixture that already has a match keeps
 * it, so a re-run (or a store that somehow re-enters go-live) never mints a second match.
 *
 * The mint mirrors the server: each ready fixture becomes an `in_progress` match, and the
 * fixture records its id + live status. The id is a deterministic v4 (`mockUuid`) keyed
 * off the fixture, so the same draw materializes to the same match every time — a stable
 * deep-link a page can be built against. */
function materializeFixtures(event: StoredEvent): StoredEvent {
  const fixtures = event.fixtures.map((fixture) => {
    const ready = fixture.entry_a_id !== null && fixture.entry_b_id !== null
    if (!ready || fixture.match_id !== null) return fixture
    return {
      ...fixture,
      match_id: mockUuid(`match:fixture:${fixture.id}`),
      match_status: 'in_progress' as const,
    }
  })
  return { ...event, fixtures }
}

/** `POST /v1/tournaments/{id}/transitions` — move a tournament along its
 * lifecycle. Owner-only, like every other tournament mutation, and the ONLY way
 * a status changes: `updateTournament` above leaves `status` alone by design. */
export function transitionTournament(
  id: string,
  to: TournamentStatus,
): TransitionResult {
  // Load (404), then ownership (403) — `requireOwned` — and only then judge the
  // edge (409). The API's ordering, so a stranger never learns what status a
  // tournament they cannot touch is in.
  const owned = requireOwned(id)
  if (!owned.ok) return owned
  const existing = owned.tournament
  if (!LEGAL_TRANSITIONS.has(`${existing.status}>${to}`)) {
    return {
      ok: false,
      status: 409,
      // The server's wording, verbatim (`api/app/tournaments.py`), in BOTH of its
      // shapes. The self-transition (`from === to`) gets its own sentence: it is
      // the common refusal — a stale tab clicking "Start tournament" on a
      // tournament that is already live is exactly the `live → live` the table
      // refuses — and the two-ended phrasing degenerates into tautology there
      // ("this tournament is live; it cannot be moved to live"), which tells the
      // player nothing. Every other illegal edge keeps the two-ended shape,
      // because the target alone doesn't say why the jump was refused.
      detail:
        existing.status === to
          ? `This tournament is already ${to}.`
          : `This tournament is ${existing.status}; it cannot be moved to ${to}.`,
    }
  }
  // THE per-target precondition (ADR-0786), judged after the edge and only for `live`:
  // publishing an empty, undrawn tournament is legal (announcing early is fine), and
  // archiving asks nothing of the draws it is putting away. Refused BEFORE the write, so
  // a refused start leaves the tournament exactly where it was — `published`, which is
  // what the header goes on rendering.
  if (to === 'live') {
    const detail = goLiveRefusal(existing)
    if (detail) return { ok: false, status: 409, detail }
  }
  // Go-live materializes every event's ready fixtures into real `in_progress` matches
  // (#788) — the same act that makes each group pairing playable and gives the draw
  // panel its "View match" links. Only on `published → live`; publishing and archiving
  // touch no fixtures.
  const events =
    to === 'live' ? existing.events.map(materializeFixtures) : existing.events
  const next: StoredTournament = {
    ...existing,
    events,
    status: to,
    updated_at: new Date().toISOString(),
  }
  replace(next)
  return { ok: true, tournament: readOf(next) }
}

/** Put a tournament directly in `status` — a **test-and-dev seam**, not a route.
 *
 * The route is `transitionTournament` above, and it enforces the server's edge table AND
 * the go-live precondition. This is the door a *fixture* comes through: a test that needs
 * a tournament which IS live (to prove entries are locked, say) is not a test of the
 * transition, and driving it through the guarded edges would make it depend on every one
 * of that edge's preconditions — so a seeded row moves here, exactly as a server-side
 * test creates its row in the status it wants rather than POSTing its way to it.
 *
 * Nothing in `handlers.ts` calls this, and nothing should: a handler that did would be
 * the mock quietly being more permissive than the server, which is the one thing this
 * store exists not to be. */
export function placeInStatus(id: string, status: TournamentStatus): void {
  const existing = tournaments.find((t) => t.id === id)
  if (!existing) return
  replace({ ...existing, status, updated_at: new Date().toISOString() })
}

/** Delete a tournament. Same gating as update. */
export function deleteTournament(id: string): DeleteResult {
  const owned = requireOwned(id)
  if (!owned.ok) return owned
  tournaments = tournaments.filter((t) => t.id !== id)
  return { ok: true }
}

// ----- an event's reservations: server-minted ids, and an id-keyed diff -----------
//
// A reservation is a ROW (ADR 20260801, `api/app/tournament_reservations.py`) and its id
// is **the server's to mint** — `ReservationWrite` (create) has no `id` at all, and
// `ReservationUpsert` (patch) has an optional one that *cites* a reservation rather than
// authoring it. So this store mints too, exactly as it does for the venue catalogue one
// resource over (`mintTable`): a reservation that arrives without an id is a new
// reservation and gets one here.
//
// And the patch is a **diff**, not an assignment: an entry citing an id keeps that
// reservation (re-named, re-timed, re-tabled, re-positioned), an entry with no id adds
// one, and a stored reservation no entry cites is REMOVED. Keying on the id is what makes
// a reorder move reservations instead of swapping labels between ids.
//
// **Groups are not part of this diff at all** (ticket #1369): they are server-owned and
// never authored, so a client cannot cite one here. `groupsFor` (above) mints exactly one
// per reservation, at the same position, purely as a function of the reservations this
// diff produces — which is what keeps a fixture's `group_id` pointing at the group its
// reservation was dealt into without this diff ever having to think about groups itself.

let reservationCounter = 0

/**
 * A brand-new reservation for an entry that carries no `id` — the mock's
 * `gen_random_uuid()`, stamped with the **position of its index in the list the client
 * sent**.
 *
 * UUID-shaped (`mockUuid`) because the wire says so (`Reservation.id` is `format:
 * uuid`), and counter-derived rather than name-derived because two reservations may
 * legitimately share a name (every event has a “Reservation A”) — and two rows sharing
 * an id is the one thing an id-keyed diff cannot survive. The counter deliberately does
 * NOT reset with the store: a fresh seed re-creates the seeded rows, and an id minted
 * for a *previous* test's reservation must never be handed out again.
 *
 * The `position` is the server's rule (`stored_reservations`/`apply_event_reservations`,
 * `api/app/tournament_reservations.py`), reproduced because a mock that is more
 * permissive than the server it stands in for is a trap. Neither write shape has a
 * `position` — both are `extra="forbid"`, so sending one is a 422 naming the field — and
 * **the order of the array is the only thing that says which reservation comes first**.
 * Defaulting to `0`, or casting a write shape through, would make the mock disagree with
 * the API about a rule the app reads on every load: the reservations editor seeds its
 * cards from `position`, and it is also what `groupsFor` (above) numbers a group's
 * position by — so every reservation, and every group mapped to one, would come back
 * tied for first.
 *
 * The fields are named rather than spread for the same reason `mintTable` names them: a
 * payload carrying a key the write shape forbids must not leak into the stored row.
 */
function mintReservation(entry: ReservationWrite, position: number): Reservation {
  reservationCounter += 1
  return {
    id: mockUuid(`tournament-event-reservation-${reservationCounter}`),
    name: entry.name,
    slot: entry.slot,
    table_ids: entry.table_ids,
    position,
  }
}

/** Every reservation of a **created** event: all new, all minted, positioned by index
 * (`stored_reservations`). `TournamentEventCreate.reservations` is `ReservationWrite[]`
 * — an event being born has no reservations to cite, so there is no id arm here at
 * all. */
function mintReservations(submitted: ReservationWrite[]): Reservation[] {
  return submitted.map((entry, index) => mintReservation(entry, index))
}

/** The server's message for an entry citing an id this **event** does not hold
 * (`ReservationNotInEventError`, `api/app/tournament_errors.py`) — a **422 on that
 * entry's `id`**, never a silently minted reservation: quietly minting one would hand
 * the client back a different id than it asked for while *removing* the reservation it
 * meant to keep, which are the two failures a diff must never confuse. */
const RESERVATION_NOT_IN_EVENT = 'This event has no reservation with that id.'

/** What the reservations diff produced, or the refusal that stopped it before anything
 * was assigned. */
type ReservationsResult =
  | { ok: true; reservations: Reservation[] }
  | { ok: false; status: 422; index: number; reservationId: string; detail: string }

/** Apply a submitted reservation list to `stored` as an id-keyed diff
 * (`apply_event_reservations`), judging the unknown-id refusal **before** anything is
 * assigned so a refused write leaves the event byte-identical.
 *
 * Judged first and over the whole payload, for the reason the catalogue's twin is: a
 * reservation list naming a reservation this event does not have is not a reservation
 * list, and every subsequent question (what is kept, and therefore what is removed)
 * would be answered against a list the client did not mean. */
function applyEventReservations(
  stored: Reservation[],
  submitted: ReservationUpsert[],
): ReservationsResult {
  const byId = new Map(stored.map((reservation) => [reservation.id, reservation]))
  for (const [index, entry] of submitted.entries()) {
    if (entry.id != null && !byId.has(entry.id)) {
      return {
        ok: false,
        status: 422,
        index,
        reservationId: entry.id,
        detail: RESERVATION_NOT_IN_EVENT,
      }
    }
  }
  return {
    ok: true,
    // The list's ORDER is the event's reservation order — a cited reservation keeps its
    // id (and every group, and therefore every fixture, mapped to it) while taking this
    // payload's words and place; an entry with no id is an insert.
    reservations: submitted.map((entry, position) =>
      entry.id == null
        ? mintReservation(entry, position)
        : {
            id: entry.id,
            name: entry.name,
            slot: entry.slot,
            table_ids: entry.table_ids,
            position,
          },
    ),
  }
}

/** #1482's reservation cap, mirrored the way `EventReservationCapExceededError`
 * states it (`api/app/schemas/tournament.py`'s `enforce_event_reservation_cap`):
 * every draw type but `rr-then-ko` runs its whole stage as one group (ADR 20260808),
 * so a second reservation would be dead data no fixture could ever be dealt into.
 * Zero stays legal — a ceiling, not a floor. */
function reservationCapExceeded(
  drawType: components['schemas']['DrawType'],
  reservationCount: number,
): boolean {
  return drawType !== 'rr-then-ko' && reservationCount > 1
}

/** The server's OWN sentence, mirrored verbatim — `enforce_event_reservation_cap`
 * composes this by hand (not through Pydantic's machinery), the same precedent
 * `DRAW_SETTINGS_REFUSALS`'s `countUnpaired` sets: a human-authored sentence on both
 * sides is one a mock can and must reproduce exactly, unlike a library's own prose. */
function reservationCapDetail(
  drawType: components['schemas']['DrawType'],
  reservationCount: number,
): string {
  return (
    `A \u201c${drawType}\u201d event runs one group, so it holds at most one ` +
    `reservation, and this one holds ${reservationCount}. Put every table in the ` +
    `one reservation, or use an \u201crr-then-ko\u201d draw, which runs several ` +
    `groups.`
  )
}

let eventCounter = 0

/** Create an event on a tournament. Creator-only (403 on a non-owned row). */
export function createEvent(
  tournamentId: string,
  body: TournamentEventCreate,
): EventResult {
  const owned = requireOwned(tournamentId)
  if (!owned.ok) return owned
  const existing = owned.tournament
  // #1482's reservation cap, judged on the CREATE body directly (a create has no
  // stored state to fall back on — the pair is exactly what was sent).
  const incomingReservationCount = (body.reservations ?? []).length
  if (reservationCapExceeded(body.draw_type, incomingReservationCount)) {
    return {
      ok: false,
      status: 422,
      reservationCapExceeded: true,
      detail: reservationCapDetail(body.draw_type, incomingReservationCount),
    }
  }
  eventCounter += 1
  const now = new Date().toISOString()
  const event: StoredEvent = {
    id: `ev-new-${eventCounter}`,
    tournament_id: tournamentId,
    name: body.name,
    format: body.format,
    draw_type: body.draw_type,
    // Minted from the event's own draw type the moment its draw settings are configured
    // (ADR 20260815 decision 3) — at CREATE, here, which is the earliest an event has a
    // draw type at all. `mintStageReads` is the one place this template lives; the
    // domain-side seed factory (`data/seed.factory.ts`'s `mintStages`) mints the SAME ids
    // for the SAME draw type, deliberately, so a component test built off one and this
    // store's own events agree on what an `rr-then-ko` event's knockout stage is called.
    stages: mintStageReads(body.draw_type),
    // **K**, stored beside the draw type it belongs to (ADR 20260727). Absent means the
    // draw type has no knockout stage to qualify for, which is `null` — the value the
    // settings row really holds — never `undefined`, and never an invented `1`: the day
    // this event's draw is cut, this is the number the bracket is sized from
    // (`planEventDraw` below), so a fallback here would deal a bracket for a K the
    // director never chose.
    qualifiers_per_group: body.qualifiers_per_group ?? null,
    // **R**, stored beside the draw type it belongs to (the swiss ADR), on exactly the same
    // terms as the qualifier count above: absent means the draw type has no round count to
    // choose, which is `null`, never `undefined` and never an invented number — the day
    // this event's draw is cut, this is how many rounds get written.
    rounds: body.rounds ?? null,
    // A missing cap is "no cap" (ADR-0935), stored as null — never undefined.
    max_players: body.max_players ?? null,
    entry_fee: body.entry_fee,
    // The IANA timezone anchoring the windows (ADR 20260719): `NOT NULL` on the
    // server, so the create body always carries it.
    timezone: body.timezone,
    // A brand-new event has no entrants, so its derived count is 0. There is no
    // `entered` to set — that's the point.
    entrants: [],
    slot: body.slot,
    match_settings: body.match_settings,
    predicates: body.predicates ?? [],
    // Every reservation on a create body is a NEW reservation — `ReservationWrite` has no
    // `id` at all — so the store mints one for each and stamps the position of its
    // index, exactly as the server does (`mintReservations`). The order the editor sent
    // its reservations in IS the order, and this is where that becomes an id and a
    // number. `groups` is not set here at all — `readEvent` derives it from
    // `reservations` on the way out (`groupsFor`, ticket #1369).
    reservations: mintReservations(body.reservations ?? []),
    // A brand-new event has NO DRAW (ADR-0786). Cutting one is an explicit act against
    // a field that does not exist yet — there is nobody entered to draw.
    fixtures: [],
    // …and NO RESULTS (ADR-0788): with no draw, there is nothing to stand.
    results: null,
    created_at: now,
    updated_at: now,
  }
  replace({ ...existing, events: [...existing.events, event] })
  return { ok: true, event: readEvent(event) }
}

/** Patch an event (full replace of the provided fields). Creator-only.
 *
 * The `reservations` payload is an **id-keyed diff** (`applyEventReservations`), and it
 * is judged twice:
 *
 * **The GROUP set freezes while a draw exists** (ADR-0786), even though the payload the
 * client sends is `reservations` — a group is server-owned, minted 1:1 with a
 * reservation (ticket #1369), so removing or adding a reservation on an event whose draw
 * is cut removes or adds the group mapped to it, and a fixture names the group it was
 * dealt into. `groupSetFrozenDetail` runs this comparison in reservation-id space (the
 * only space the payload speaks) while it reports and refuses in the group's own terms —
 * the terms a fixture, and a director, actually recognise. Everything ELSE about a
 * reservation — its tables, its window, its name — stays editable with a draw standing,
 * because venues change under running tournaments and recording that must not cost a
 * director their draw. (Re-*identifying* a reservation is no longer one of the things
 * this refuses, because it is no longer a payload a client can send: a reservation id is
 * minted here, so an entry either cites one this event has or carries none at all.)
 *
 * **An entry citing an id this event does not have is a 422** on that entry (ADR
 * 20260801), judged *after* the freeze so a cut event answers the 409 that names its
 * groups.
 *
 * The mock enforces both because a mock that is more permissive than the server it stands
 * in for is a trap: a reservations editor that silently orphans a draw would look perfect
 * in `npm run dev` and 409 in production. */
export function updateEvent(
  tournamentId: string,
  eventId: string,
  patch: TournamentEventUpdate,
): EventResult {
  const owned = requireOwned(tournamentId)
  if (!owned.ok) return owned
  const existing = owned.tournament
  const event = existing.events.find((e) => e.id === eventId)
  if (!event) return { ok: false, status: 404 }
  // 404 → 403 → 409, the server's ordering: the state of an event's draw is never the
  // reason a stranger's request is refused. (The *schema's* 422s come before all of it —
  // the handler asks them at the boundary; see `validateEventBody`. The diff's own 422,
  // below, comes after, so a cut event answers the freeze.)
  const frozen = groupSetFrozenDetail(event, patch) ?? drawTypeFrozenDetail(event, patch)
  if (frozen !== null) return { ok: false, status: 409, detail: frozen }
  // #1482's reservation cap, judged AFTER both freezes — the freeze is the refusal a
  // director can act on (remove the draw, then edit), so a cut event already over the
  // cap answers THAT 409 first — and BEFORE the id-keyed diff below, on the EFFECTIVE
  // pair: the incoming draw type or the stored one, the incoming reservation count (this
  // patch's own `reservations.length`, since the diff replaces wholesale when present) or
  // the stored one. A patch that touches only one half of the pair is still judged
  // against the state it would leave the event in.
  //
  // A NO-OP when this patch touches neither half of the pair, mirroring the server's
  // `_enforce_reservation_cap` (`api/app/tournament_events.py`), whose first line is
  // the same early return: a legacy event already over the cap (data only reachable
  // pre-#1482, since both write paths now refuse to create one) must still accept an
  // edit to its name or its fee. Unreachable through this editor, which always sends
  // both keys (`eventToUpdateBody`, and `data/api.test.ts` pins that) — which is
  // exactly why the mirror is worth its one line: the day a PATCH shape drops a key,
  // the mock must not start refusing a write the real server accepts.
  const touchesThePair = patch.reservations != null || patch.draw_type != null
  const effectiveDrawType = patch.draw_type ?? event.draw_type
  const effectiveReservationCount =
    patch.reservations == null ? event.reservations.length : patch.reservations.length
  if (
    touchesThePair &&
    reservationCapExceeded(effectiveDrawType, effectiveReservationCount)
  ) {
    return {
      ok: false,
      status: 422,
      reservationCapExceeded: true,
      detail: reservationCapDetail(effectiveDrawType, effectiveReservationCount),
    }
  }
  // The diff runs BEFORE anything is written, so an entry citing an unknown id leaves the
  // event exactly as it was — never written, not merely rolled back.
  const reservations =
    patch.reservations == null
      ? null
      : applyEventReservations(event.reservations, patch.reservations)
  if (reservations !== null && !reservations.ok) return reservations
  const next: StoredEvent = {
    ...event,
    name: patch.name ?? event.name,
    format: patch.format ?? event.format,
    draw_type: patch.draw_type ?? event.draw_type,
    // **Re-minted on a draw-type change, in place** (ADR 20260815 decision 3): a patch
    // naming a new draw type re-applies the template, same as create. This can only be
    // reached with no draw standing — `drawTypeFrozenDetail` above already 409s a
    // draw-type change while one exists — so there is no fixture yet to leave pointing at
    // a stage this mints away, and a full re-mint is the read this store's simpler model
    // can give (the ADR's "stage 1 keeps its identity" nuance matters once a group is
    // stage-scoped, which this store's groups are not yet — ADR 20260815, "Sequencing with
    // #1338"). A patch naming no draw type leaves the stages exactly as they stood.
    stages:
      patch.draw_type === undefined || patch.draw_type === null
        ? event.stages
        : mintStageReads(patch.draw_type),
    // **The draw configuration is patched as a UNIT** (ADR 20260727): the server refuses
    // a `qualifiers_per_group` with no `draw_type` beside it (422), so a patch that names
    // a draw type carries the whole pair — including the `null` that *removes* a count
    // when the type moves to one that has no knockout stage. Reading it with `??` would
    // strand the old K on the new type, which is precisely the contradiction the union
    // exists to make unrepresentable. A patch that names no draw type is not touching the
    // configuration at all, and leaves both halves alone.
    qualifiers_per_group:
      patch.draw_type === undefined || patch.draw_type === null
        ? event.qualifiers_per_group
        : (patch.qualifiers_per_group ?? null),
    // …and **R** moves with the very same unit, for the very same reason (the swiss ADR).
    // Reading it with `??` would strand a swiss event's round count on a round-robin it was
    // just re-typed as — the contradiction the union exists to make unrepresentable.
    rounds:
      patch.draw_type === undefined || patch.draw_type === null
        ? event.rounds
        : (patch.rounds ?? null),
    // An explicit `null` clears the cap (ADR-0935); only an *absent* key leaves
    // the stored cap untouched. `??` would conflate the two, silently keeping a
    // cap the editor meant to remove.
    max_players:
      'max_players' in patch ? (patch.max_players ?? null) : event.max_players,
    entry_fee: patch.entry_fee ?? event.entry_fee,
    // The timezone is `NOT NULL`, so like the other required columns an explicit
    // `null` is a no-op and an absent key leaves it (ADR 20260719).
    timezone: patch.timezone ?? event.timezone,
    // Entrants are not in the PATCH body — an editor edit never touches the
    // registrations, so the derived count survives the edit untouched.
    entrants: event.entrants,
    slot: patch.slot ?? event.slot,
    match_settings: patch.match_settings ?? event.match_settings,
    predicates: patch.predicates ?? event.predicates,
    // The diff's answer: cited reservations kept (with their ids, and therefore the
    // group — and every fixture — mapped to them), id-less entries minted, stored
    // reservations no entry cited dropped — and every one of them RE-POSITIONED from the
    // array index, which is what makes "send them in the order you want" the whole
    // reordering API. An absent `reservations` is not touching them at all, and the
    // stored positions stand.
    reservations: reservations === null ? event.reservations : reservations.reservations,
    // The DRAW survives an edit (ADR-0786): a PATCH is not a re-cut. `fixtures` is not
    // in the write body at all, and answering `[]` here would tell the director their
    // draw had just been thrown away by a rename.
    fixtures: event.fixtures,
    updated_at: new Date().toISOString(),
  }
  replace({
    ...existing,
    events: existing.events.map((e) => (e.id === eventId ? next : e)),
  })
  return { ok: true, event: readEvent(next) }
}

// ----- the draw (ADR-0786) -------------------------------------------------
//
// Cutting a draw is an EXPLICIT act, and the mock models it as one: nothing else in this
// store creates a fixture, and no status change cuts one. The two verbs are refused for
// exactly the reasons the server refuses them, because a mock that is more permissive
// than the server it stands in for is a trap — a Generate button that "worked" in
// `npm run dev` and 422'd in production would look like a server bug rather than the
// missing generator it is.

/** Cutting a draw fails four ways, in the API's order: 404 (no such tournament or
 * event), 403 (not the owner), 409 (the draw shows evidence of play), 422 (this event
 * cannot be planned as it stands). The 409 and the 422 carry the server's own sentence,
 * because for these two the sentence is the *point*: it names what the director has to
 * change. */
export type CutDrawResult =
  | { ok: true; fixtures: TournamentFixtureRead[] }
  | { ok: false; status: 403 | 404 }
  | { ok: false; status: 409 | 422; detail: string }

/** Un-cutting fails the same ways minus the 422 — there is nothing to plan. Removing a
 * draw that was never cut is a SUCCESS (idempotent DELETE), never a 404. */
export type UncutDrawResult =
  | { ok: true }
  | { ok: false; status: 403 | 404 }
  | { ok: false; status: 409; detail: string }

/** The server's sentence for a draw that can no longer be touched, verbatim
 * (`_enforce_draw_unplayed`, `api/app/tournaments.py`). One sentence for both verbs,
 * because it is one fact: the fixtures a re-cut would replace and the fixtures an un-cut
 * would delete are the same fixtures, and they have been played. */
const DRAW_UNDER_WAY_DETAIL =
  "This event's draw is already under way — at least one fixture has a match " +
  'or a recorded winner — so it can no longer be cut or removed.'

/** Evidence of play, in the server's terms: a fixture with a recorded winner, or one
 * that has become a real match. Deliberately stricter than "somebody has played" — a
 * merely *linked* match blocks a re-cut, because the scores already on its scratchpad
 * would go with the fixtures the re-cut replaced, and a draw must never silently eat a
 * score. */
function drawHasPlay(event: StoredEvent): boolean {
  return event.fixtures.some(
    (f) => f.winner_entry_id !== null || f.match_id !== null,
  )
}

/** Why this event's GROUP set may not be replaced right now, or `null` when it may be
 * (`_enforce_group_set_frozen`, ADR-0786). Frozen only while a draw EXISTS — not while it
 * has been *played*: the two are different questions, and the morning of a tournament
 * (a draw cut, nothing played yet) is exactly when a blunt play-guard would wave through
 * an edit that orphans every fixture.
 *
 * **What is frozen is the group set, but what the payload diffs is reservations**
 * (ticket #1369) — a group is server-owned and never reaches a client, so this guard
 * runs the comparison in the reservation's id space (the one the payload actually
 * speaks) while it still reports and refuses in the group's own terms: `Group B`-style
 * labels derived from the POSITION the group (equivalently, its mapped reservation)
 * already holds, because that is what a fixture actually names and what a director
 * actually recognises. Under this slice's 1:1 the two id spaces are in exact bijection,
 * so the comparison is sound.
 *
 * **The freeze shrank when the ids were minted** (ADR 20260801). Two categories still
 * reach it — *removing* a reservation the draw was dealt across (which removes the group
 * mapped to it), and *adding* one that would arrive with a group that has no fixtures —
 * and the third, *re-identifying* a reservation, is no longer expressible at all: a
 * client cannot author a reservation id, so an entry either cites one this event has
 * (which keeps that reservation, and its group) or carries none (which adds one).
 *
 * Identity is all that is frozen. A `reservations` payload citing exactly the
 * reservations the event has, in a different order, with different tables, different
 * windows or different names, is fine — that is the case this guard exists to *permit*.
 *
 * The sentence is the server's, verbatim (`_group_set_frozen_detail`,
 * `api/app/tournament_events.py`), because the client shows it verbatim: it names the
 * groups on both sides, it states that a reservation's tables/time/name stay editable,
 * and it names the way out. */
function groupSetFrozenDetail(
  event: StoredEvent,
  patch: TournamentEventUpdate,
): string | null {
  if (patch.reservations === undefined || patch.reservations === null) return null
  if (event.fixtures.length === 0) return null
  const existing = new Set(event.reservations.map((r) => r.id))
  // An entry with no `id` is an addition and contributes nothing to the incoming SET —
  // which is what makes the comparison below "you cited exactly the reservations you
  // have" rather than "you sent the same number of them".
  const incoming = new Set(
    patch.reservations.map((r) => r.id).filter((id): id is string => id != null),
  )
  const cites = patch.reservations.length === incoming.size
  const same =
    existing.size === incoming.size && [...existing].every((id) => incoming.has(id))
  if (same && cites) return null
  // Removed groups are NAMED, from the row we hold: the label its stored position
  // derives, which is the label the director is looking at right now. Added groups are
  // COUNTED, not named — they have no position yet, and the label they would land on is
  // one an existing group currently wears, so naming them makes the sentence contradict
  // itself ("Group A already has fixtures…; and Group A would arrive with no fixtures").
  // Mirrors `app.tournament_events._group_set_frozen_detail` byte for byte. An entry
  // citing an id this event does not have counts as an addition here — it is one in
  // effect, and past this guard it is the 422 `applyEventReservations` answers.
  const removed = event.reservations
    .map((r, position) => ({ r, position }))
    .filter(({ r }) => !incoming.has(r.id))
    .map(({ position }) => `Group ${groupLetter(position)}`)
  const added = patch.reservations.filter(
    (r) => r.id == null || !existing.has(r.id),
  ).length
  const clauses: string[] = []
  if (removed.length > 0) {
    clauses.push(
      `${namedList(removed)} already has fixtures drawn into it, ` +
        'which this change would leave pointing at a group that no longer exists',
    )
  }
  if (added > 0) {
    clauses.push(
      `${added} new ${added === 1 ? 'group' : 'groups'} would arrive with no ` +
        `fixtures in ${added === 1 ? 'it' : 'them'}, because the draw was cut ` +
        'across the groups this event had at the time',
    )
  }
  return (
    "This event's draw is already cut, so its set of groups is frozen: " +
    clauses.join('; and ') +
    ". A reservation's tables, its time and its name can all still be changed. " +
    'To add or remove a group, remove the draw first, then cut it again.'
  )
}

/** Why this event's `draw_type` may not be replaced right now, or `null` when it may be
 * (`_enforce_draw_type_frozen`, ADR-0786). The group-set freeze's sibling, one field
 * over: a draw type is not a label on an event, it is the strategy that DEALT its
 * fixtures, and re-labelling it under a standing draw leaves the event claiming a shape
 * its draw does not have (a `single-elim` event holding grouped round-robin fixtures —
 * the PATCH the server used to answer **200**).
 *
 * **Presence is not enough — the CHANGE is what is refused.** The editor PATCHes the
 * whole form back, `draw_type` included, to move a reservation's tables; a mock that
 * fired on the mere presence of the key would refuse the very edit the freeze exists to
 * permit, and the reservations editor would look broken in `npm run dev` against a
 * server that allows it. */
function drawTypeFrozenDetail(
  event: StoredEvent,
  patch: TournamentEventUpdate,
): string | null {
  if (patch.draw_type === undefined || patch.draw_type === null) return null
  if (patch.draw_type === event.draw_type) return null
  if (event.fixtures.length === 0) return null
  return (
    "This event's draw is already cut, so its draw type is frozen: its fixtures were " +
    `dealt as a “${event.draw_type}” draw, and changing the type would leave the event ` +
    'claiming a shape its draw does not have. To change the draw type, remove the draw ' +
    'first, then cut it again.'
  )
}

/** Plan a stored event's draw, or say why it cannot be — the decision itself lives in
 * `planDraw` (`mocks/factories/tournaments/tournament.factory.ts`), shared with the
 * Playwright store so the two stubs cannot drift on which draws are refused or on the
 * server's own sentences for refusing them. What is local here is only how a *stored*
 * row is read into the planner's arguments. */
function planEventDraw(event: StoredEvent): DrawPlan {
  // Entrants are ordered by SEED ascending where one is set, then by registration order
  // (ADR-0786) — the store lists them in registration order already, so this is a stable
  // sort that floats the seeded ones to the front. Nothing is random, so the same field
  // always cuts the same draw, and a re-cut of an unchanged field is a no-op in effect.
  const ordered = [...event.entrants].sort(
    (a, b) => (a.seed ?? Number.MAX_SAFE_INTEGER) - (b.seed ?? Number.MAX_SAFE_INTEGER),
  )
  // The GROUP STAGE's own group ids — `groupsForEvent` (ADR 20260823), filtered to
  // stage 0, never the raw reservation list: since this event's stages must agree
  // with what `readEvent` shows for the SAME event (never a lying mock — the wire's
  // `groups[]` and what the snake actually deals into must be the one derivation),
  // and never the knockout stage's own group either — "the snake deals only into the
  // stage being dealt" is this client's twin of the ticket's own most-dangerous-
  // consequence guard. Stage 0 is every draw type's group stage (or its one and only
  // stage, for the three that have no knockout stage to distinguish it from).
  const groupStageId = [...event.stages].sort((a, b) => a.position - b.position)[0]?.id
  const groupStageGroupIds = groupsForEvent(event)
    .filter((g) => g.stage_id === groupStageId)
    .map((g) => g.id)
  return planDraw(
    event.draw_type,
    ordered.map((e) => e.id),
    groupStageGroupIds,
    // **The event's own K** (ADR 20260727) — the stored number, passed through unchanged.
    // `null` is the honest answer for a count-less draw type, and only the `rr-then-ko`
    // arm reads it at all; an `rr-then-ko` event always has one (its create/patch body is
    // a 422 without it), so that arm never meets the null.
    //
    // ⚠️ Substituting anything here is the whole bug this argument closes, and it is a
    // SILENT one: an event configured at K=2 would be cut into a `P × 1` bracket — a
    // perfectly well-formed draw of the wrong size, with nothing anywhere reporting it.
    event.qualifiers_per_group,
    // **The event's own R** (the swiss ADR) — the stored number, passed through unchanged,
    // for exactly the reasons the qualifier count above is. Only the `swiss` arm reads it,
    // and a swiss event always has one, so that arm never meets the null.
    event.rounds,
    // **The event's own stages** (ADR 20260815) — never `planDraw`'s
    // `mintStageReads(drawType)` default, which is for a caller with no event to read
    // stages off of. A fixture this cuts must name a stage `event.stages` actually holds.
    event.stages,
  )
}

/** `POST …/events/{event_id}/draw` — cut (or re-cut) an event's draw.
 *
 * **A re-cut replaces the draw wholesale**: the old fixtures are dropped and a fresh set
 * is planned from the event's *current* active entrants, so their ids do not survive.
 * That is the point — a draw is a plan made against a field, and once the field has
 * changed the whole plan is re-made, group sizes and seeding included.
 *
 * The 422s are the planner's (see `planDraw` in the tournament factory, shared with the
 * Playwright store), and they are the ones a director actually meets: a round-robin with
 * no groups, a group the snake would leave with fewer than two entrants, a bracket of
 * fewer than two, and a two-stage draw whose knockout would hold one player.
 * **There is no draw-TYPE refusal**: every member of `DrawType` has a strategy on the
 * server (ADR 20260726) and a planner here, so a mock that still refused one would be
 * putting a sentence in the server's mouth that it can no longer say — and would make
 * that draw untestable in `npm run dev`, in vitest and in the browser at once. */
export function cutDraw(tournamentId: string, eventId: string): CutDrawResult {
  const owned = requireOwned(tournamentId)
  if (!owned.ok) return owned
  const existing = owned.tournament
  const event = existing.events.find((e) => e.id === eventId)
  if (!event) return { ok: false, status: 404 }
  // The one gate on the write, asked BEFORE anything is planned or dropped — so a
  // refused re-cut leaves the standing draw exactly as it was.
  if (drawHasPlay(event)) {
    return { ok: false, status: 409, detail: DRAW_UNDER_WAY_DETAIL }
  }
  const plan = planEventDraw(event)
  if (!plan.ok) return { ok: false, status: 422, detail: plan.detail }
  const fixtures = plan.fixtures
  const next: StoredEvent = { ...event, fixtures }
  replace({
    ...existing,
    events: existing.events.map((e) => (e.id === eventId ? next : e)),
  })
  return { ok: true, fixtures }
}

/** `DELETE …/events/{event_id}/draw` — un-cut an event's draw.
 *
 * Idempotent: an event with no draw is already in the state this asks for, so it is a
 * success (a 204 on the wire), never a 404. The one refusal is the play guard the cut
 * has — undoing a draw that has been played would delete the fixtures those results
 * belong to. */
export function uncutDraw(
  tournamentId: string,
  eventId: string,
): UncutDrawResult {
  const owned = requireOwned(tournamentId)
  if (!owned.ok) return owned
  const existing = owned.tournament
  const event = existing.events.find((e) => e.id === eventId)
  if (!event) return { ok: false, status: 404 }
  if (drawHasPlay(event)) {
    return { ok: false, status: 409, detail: DRAW_UNDER_WAY_DETAIL }
  }
  const next: StoredEvent = { ...event, fixtures: [] }
  replace({
    ...existing,
    events: existing.events.map((e) => (e.id === eventId ? next : e)),
  })
  return { ok: true }
}

/** Record a played fixture on an event, **behind the API's back** — the state no client
 * call can reach yet (materializing a fixture into a match is #788, and recording a
 * winner is #789), and the only way to reach the 409 both draw verbs are guarded by.
 *
 * Test-and-dev seam, exactly like the seeded `ineligible` verdict above: without it the
 * play guard would be unreachable from this store, and a guard nothing can exercise is a
 * guard that quietly rots into a no-op. */
export function markFixturePlayed(
  tournamentId: string,
  eventId: string,
  fixtureId: string,
  played: Partial<Pick<TournamentFixtureRead, 'winner_entry_id' | 'match_id'>>,
): void {
  const existing = tournaments.find((t) => t.id === tournamentId)
  if (!existing) return
  replace({
    ...existing,
    events: existing.events.map((e) =>
      e.id === eventId
        ? {
            ...e,
            fixtures: e.fixtures.map((f) =>
              f.id === fixtureId ? { ...f, ...played } : f,
            ),
          }
        : e,
    ),
  })
}

export type PlaceFixtureResult =
  | { ok: true; fixture: TournamentFixtureRead }
  | { ok: false; status: 403 | 404 }
  | { ok: false; status: 409; detail: string }
  | { ok: false; status: 422; detail: string }

/** The server's sentence for a placement that can no longer be changed, verbatim in
 * spirit (`api/app/tournaments.py`): a `completed`/`voided` match's table and time are
 * history. */
const PLACEMENT_FROZEN_DETAIL =
  "This match is finished, so its placement can no longer be changed."

/** `PATCH /v1/tournaments/{id}/fixtures/{fixtureId}/placement` — set (or clear) a
 * fixture's placement (ADR-0790). Creator-only (403), 404 for a fixture that is not on
 * any of the tournament's events.
 *
 * **One hard rule, everything else soft.** An out-of-window time, a table outside the
 * fixture's group's reservation, and a double-booking are all *stored*, not refused —
 * those stay
 * flags-on-read (ADR-0790, undisturbed). The **one** invariant is that `table_id` must
 * name a table in this tournament's own catalogue (`_enforce_table_exists`,
 * `api/app/tournament_placement.py`, ADR 20260801) — a **422 on `table_id`**, judged
 * before the freeze check ever runs, so this mock cannot accept a placement the real API
 * would refuse. `null` is not a miss: it is "unplace", and always passes. The other
 * refusal is a **409** on a fixture whose match is `completed`/`voided`; everything else
 * — no match yet, or `in_progress` — is freely (re)placeable.
 *
 * The **pin consequences** mirror the server's transition table
 * (`apply_manual_placement`, `api/app/match_calls.py`) via the shared
 * `manualPlacementPin` (`solver-sim.ts`, where the table is documented branch for
 * branch) — one implementation for this store and the e2e stub alike. */
export function placeFixture(
  tournamentId: string,
  fixtureId: string,
  body: components['schemas']['TournamentFixturePlacementUpdate'],
): PlaceFixtureResult {
  const owned = requireOwned(tournamentId)
  if (!owned.ok) return owned
  const existing = owned.tournament
  const event = existing.events.find((e) =>
    e.fixtures.some((f) => f.id === fixtureId),
  )
  if (!event) return { ok: false, status: 404 }
  const fixture = event.fixtures.find((f) => f.id === fixtureId)!
  if (fixture.match_status === 'completed' || fixture.match_status === 'voided') {
    return { ok: false, status: 409, detail: PLACEMENT_FROZEN_DETAIL }
  }
  if (
    body.table_id !== null &&
    !existing.table_catalogue.some((table) => table.id === body.table_id)
  ) {
    return { ok: false, status: 422, detail: TABLE_NOT_IN_CATALOGUE }
  }

  // The pin consequences — the server's transition table, via the shared sim
  // (`manualPlacementPin`, `solver-sim.ts`), so this store and the e2e stub
  // cannot drift apart on them.
  const placed: TournamentFixtureRead = {
    ...fixture,
    table_id: body.table_id,
    // The wire ships a placement's predicted start as a `FixtureTimeRead` (ADR
    // "tournament times are timezone-aware instants"); the PATCH body still names a
    // naive venue wall-clock, so the store composes the read shape the client parses.
    scheduled_start:
      body.scheduled_start === null ? null : simFixtureTime(body.scheduled_start),
    ...manualPlacementPin(
      existing.events,
      fixture,
      { table_id: body.table_id, scheduled_start: body.scheduled_start },
      existing.status === 'live',
    ),
  }
  replace({
    ...existing,
    events: existing.events.map((e) =>
      e.id === event.id
        ? {
            ...e,
            fixtures: e.fixtures.map((f) => (f.id === fixtureId ? placed : f)),
          }
        : e,
    ),
  })
  return { ok: true, fixture: placed }
}

// ----- the schedule solver (ADR "the schedule is solved; the call is pinned") -----
//
// One verb: `POST …/schedule/solves` queues a run of the placement solver — the
// owner's Run-scheduler button. There is deliberately no GET: the solve's outcome is
// read off the tournament detail's `latest_schedule_solve` (one BFF endpoint per
// page), which is exactly what the client polls.
//
// The mock has no worker, so the ledger row is walked forward BY THE READS
// (`tickScheduleSolve` below): the POST answers 202 with a `queued` row, the next
// detail read shows it `running`, and the read after that lands it `succeeded` with
// every unplaced fixture placed onto its group's reservation's tables. Two reads is the
// demo loop —
// with the client's in-flight polling (~3s) the strip visibly resolves in `npm run
// dev` without anyone reloading.
//
// The pure `events in → events out` half of all of this — the placement pass, the
// calling pass, the step function, the refusal message — is the shared
// `solver-sim.ts`, which the e2e Playwright stub store consumes too; this store
// keeps only the state plumbing around it.

/** Requesting a solve fails three ways, in the API's order: 404 (no such
 * tournament), 403 (not the owner), and a **coded 422** (`no_drawn_events`) when no
 * event has a draw — there is nothing to place. The 503 (queue down) is not
 * modelled: the mock has no queue to lose. */
export type RequestSolveResult =
  | { ok: true; solve: ScheduleSolveRead }
  | { ok: false; status: 403 | 404 }
  | { ok: false; status: 422; code: 'no_drawn_events'; message: string }

let solveCounter = 0

/** `POST …/schedule/solves` — queue a run of the schedule solver. Owner-only.
 *
 * **One solve in flight per tournament**, as on the server: while a run is `queued`
 * or `running`, another click is absorbed by it and the SAME row comes back (same
 * id) — the 202 is honest either way, the work is accepted, not done. Only when
 * nothing is in flight is a fresh `queued` row minted. */
export function requestScheduleSolve(tournamentId: string): RequestSolveResult {
  const owned = requireOwned(tournamentId)
  if (!owned.ok) return owned
  const existing = owned.tournament
  if (!existing.events.some((e) => e.fixtures.length > 0)) {
    return {
      ok: false,
      status: 422,
      code: 'no_drawn_events',
      message: NO_DRAWN_EVENTS_MESSAGE,
    }
  }
  const current = existing.latest_schedule_solve
  if (solveRowInFlight(current)) {
    // Absorbed (queued) or rerun-flagged (running): the existing row answers.
    return { ok: true, solve: current }
  }
  solveCounter += 1
  const solve = queuedSolveRow(
    mockUuid(`schedule-solve:${tournamentId}:${solveCounter}`),
  )
  replace({ ...existing, latest_schedule_solve: solve })
  return { ok: true, solve }
}

/** When the mock worker last advanced — the dwell below reads it. */
let lastSolveTickAt = 0

/** Walk an in-flight solve one step forward, on read (`stepScheduleSolve`, the
 * shared sim): `queued` → `running`, and `running` → `succeeded` with the
 * placements applied. Terminal rows are left exactly as they are. Called from
 * `findTournament` — the read the Schedule tab polls — so the strip resolves at
 * the polling cadence, like the real worker would.
 *
 * **At most one step per dwell** (`SOLVE_TICK_DWELL_MS`): a mutation's reconcile
 * can land two detail reads back-to-back (the list key prefix-matches the detail
 * key, so one invalidate refetches it twice), and a tick per read would walk
 * queued → succeeded inside a single reconcile — `npm run dev` would never show
 * the "solving…" state the whole loop exists to demo. */
function tickScheduleSolve(t: StoredTournament): StoredTournament {
  const solve = t.latest_schedule_solve
  if (!solve || !solveRowInFlight(solve)) return t
  const now = Date.now()
  if (now - lastSolveTickAt < SOLVE_TICK_DWELL_MS) return t
  lastSolveTickAt = now
  const step = stepScheduleSolve(solve, t.events, t.status === 'live')
  if (!step) return t
  return { ...t, events: step.events, latest_schedule_solve: step.solve }
}

/** Delete an event. Creator-only. */
export function deleteEvent(
  tournamentId: string,
  eventId: string,
): DeleteResult {
  const owned = requireOwned(tournamentId)
  if (!owned.ok) return owned
  const existing = owned.tournament
  const event = existing.events.find((e) => e.id === eventId)
  if (!event) return { ok: false, status: 404 }
  replace({
    ...existing,
    events: existing.events.filter((e) => e.id !== eventId),
  })
  return { ok: true }
}

let entryCounter = 0

// A tournament's status IS its registration window (ADR-0017): `published` is
// open, and the other three are shut for three different reasons — a draft is not
// announced yet, a live tournament's field is fixed (the draw is cut from it), and
// an archived one is over. The server refuses entry and active-entry withdrawal
// outside `published` with a 409, so the mock must too: a mock that is MORE
// permissive than the server it stands in for is a trap, and a regression that
// offered Enter on a `live` tournament would 201 here, pass every vitest test, and
// look fine in `npm run dev`.
//
// A `Record` keyed by the closed statuses (not by the whole enum) is the exhaustive
// match the server's `_registration_closed_detail` makes with `assert_never`: a
// fourth closed status added to `TournamentStatus` tomorrow is a type error at this
// literal until it is given words, and no key can be missing at runtime.
const REGISTRATION_CLOSED_DETAIL: Record<
  Exclude<TournamentStatus, 'published'>,
  string
> = {
  // The server's wording, verbatim (`_registration_closed_detail`,
  // `api/app/tournaments.py`) — "not yet" and "too late" are different things to
  // be told, and this copy is what the player reads.
  draft:
    'This tournament has not been published yet, so its events are not open for entry.',
  live: 'This tournament is already under way, so its entries are locked.',
  archived:
    'This tournament has ended, so its events can no longer be entered.',
}

/** Why registration is refused, or `null` while the window is open. One function,
 * because entering and withdrawing an active entry are refused for the *same*
 * reason — exactly as on the server. */
function registrationClosedDetail(t: StoredTournament): string | null {
  return t.status === 'published' ? null : REGISTRATION_CLOSED_DETAIL[t.status]
}

/** Enter the dev user into an event — the caller is always the entrant (there is
 * no request body; self-registration only). Not creator-gated: the whole point
 * is that a player writes to a tournament they don't own. */
export function enterEvent(
  tournamentId: string,
  eventId: string,
): EnterResult {
  const existing = tournaments.find((t) => t.id === tournamentId)
  if (!existing) return { ok: false, status: 404 }
  const event = existing.events.find((e) => e.id === eventId)
  if (!event) return { ok: false, status: 404 }
  // One row per user can't express a doubles pairing or a team (ADR-0016).
  if (event.format !== 'singles') return { ok: false, status: 400 }
  // Ordering, mirrored from the server: the format 400 first, then the status 409
  // — the permanent refusal before the transient one. A 409 says "not now" and
  // invites the caller back once the tournament is published; a doubles event will
  // never be enterable through this route in ANY status, so it must be answered
  // with the fact that will not change.
  const closed = registrationClosedDetail(existing)
  // 409, not 403 (ADR-0017): the caller is permitted and the entry would be their
  // own — the *tournament* is in the wrong state. "Not now", never "not you". The
  // code is what the client reads; the per-status sentence rides along as the
  // message, exactly as the server sends it (ADR-0968).
  if (closed !== null) {
    return {
      ok: false,
      status: 409,
      refusal: { code: 'registration_closed', message: closed },
    }
  }
  // The server's partial unique index, in miniature: at most one *active* entry
  // per player per event. A second one is a 409, never a second row. It is asked
  // BEFORE the event's own refusals below, exactly as the client's
  // `entryControlState` asks it: a player who is already in a full event is
  // already in — telling them the event is full would be true and useless.
  if (event.entrants.some((e) => e.user_id === DEV_USER_ID)) {
    return {
      ok: false,
      status: 409,
      refusal: {
        code: 'already_entered',
        message: 'You have already entered this event.',
      },
    }
  }
  // Eligibility BEFORE capacity (ADR-0783): an ineligible player looking at a full
  // event is told they are ineligible, because "it's full" would invite them back
  // for a place that will never be theirs. The wording is the server's fallback
  // sentence; the CODE is what the client actually reads (ADR-0968).
  const refusal = readEvent(event).entry_state
  if (refusal.state === 'rating_ineligible') {
    return {
      ok: false,
      status: 409,
      refusal: {
        code: 'rating_ineligible',
        message: 'Your rating does not meet this event’s eligibility rules.',
      },
    }
  }
  if (refusal.state === 'event_full') {
    return {
      ok: false,
      status: 409,
      refusal: { code: 'event_full', message: 'This event is full.' },
    }
  }
  entryCounter += 1
  const entrant: TournamentEntrantRead = {
    id: `entry-me-${entryCounter}`,
    user_id: DEV_USER_ID,
    username: DEV_USERNAME,
    seed: null,
    rating: DEV_USER_RATING,
  }
  const next: StoredEvent = { ...event, entrants: [...event.entrants, entrant] }
  replace({
    ...existing,
    events: existing.events.map((e) => (e.id === eventId ? next : e)),
  })
  return { ok: true, entrant }
}

/** Withdraw one entry. A player may only withdraw their *own* (someone else's is
 * a 403). Withdrawing an entry that is no longer active is idempotent — the
 * server soft-deletes, so a repeat DELETE is still a 204; here the row is simply
 * already gone. Dropping it (rather than tombstoning) is faithful on the wire:
 * a withdrawn entry appears in neither the list nor the count, and the player can
 * enter again straight away.
 *
 * Withdrawal is gated on the registration window too (ADR-0017) — pulling a player
 * out of a `live` tournament would empty a slot the draw was cut from — but the
 * gate is on the state CHANGE, not on the call: see the ordering below. */
export function withdrawEntry(
  tournamentId: string,
  eventId: string,
  entryId: string,
): WithdrawResult {
  const existing = tournaments.find((t) => t.id === tournamentId)
  if (!existing) return { ok: false, status: 404 }
  const event = existing.events.find((e) => e.id === eventId)
  if (!event) return { ok: false, status: 404 }
  const entrant = event.entrants.find((e) => e.id === entryId)
  // Already withdrawn (or never existed): idempotent, exactly as on the server —
  // and deliberately BEFORE the status gate below, so it stays a 204 in `live` and
  // `archived` too. This is DELETE: asking for a state the resource is already in
  // is a success (ADR-0016), and an entry that is already withdrawn has nothing
  // left to lock. A gate applied bluntly would quietly turn it into a 409 for a
  // request that changes nothing — a conflict with no conflict in it.
  if (!entrant) return { ok: true }
  // The 403 precedes the status 409, as on the server: withdrawing someone else's
  // entry from a live tournament is "not yours" (which will never change), not
  // "not now" (which invites a pointless retry).
  if (entrant.user_id !== DEV_USER_ID) return { ok: false, status: 403 }
  // The entry is active and it is the caller's, so this call really would change
  // state — and outside `published` the field is not the caller's to change.
  const closed = registrationClosedDetail(existing)
  if (closed !== null) return { ok: false, status: 409, detail: closed }
  const next: StoredEvent = {
    ...event,
    entrants: event.entrants.filter((e) => e.id !== entryId),
  }
  replace({
    ...existing,
    events: existing.events.map((e) => (e.id === eventId ? next : e)),
  })
  return { ok: true }
}
