import type { Page, Route } from '@playwright/test'

import type { components } from '../../../src/api/schema'
import { PERM } from '../../../src/lib/permissions'
import {
  manualPlacementPin,
  NO_DRAWN_EVENTS_MESSAGE,
  queuedSolveRow,
  simFixtureTime,
  SOLVE_TICK_DWELL_MS,
  solveRowInFlight,
  stepScheduleSolve,
} from '../../../src/mocks/factories/tournaments/solver-sim'
import {
  buildEventResultsRead,
  buildGroupStandingsRead,
  buildStandingRowRead,
  buildStandingsThenFinishesResultsRead,
  buildTournamentDetailRead,
  buildTournamentEventRead,
  buildTournamentEntrantRead,
  DRAW_TYPE_CATALOGUE,
  entryStateFor,
  mintStageReads,
  planDraw,
  UNBREAKABLE_TOURNAMENT_NAME,
  UNBREAKABLE_VENUE_NAME,
  type DrawPlan,
} from '../../../src/mocks/factories/tournaments/tournament.factory'
import { mockUuid } from '../../../src/mocks/mock-uuid'
import { groupIdFor, groupsFor } from '../../../src/mocks/factories/tournaments/solver-sim'
import { groupLetter } from '../../../src/components/tournaments/data/draw-structure'
import { sessionResponse } from '../../../src/test/factories'
import { fulfillParkedStream, STREAM_PATH } from '../../support/realtime'

type TournamentDetailRead = components['schemas']['TournamentDetailRead']
type TournamentCreate = components['schemas']['TournamentCreate']
type TournamentUpdate = components['schemas']['TournamentUpdate']
type TournamentTable = components['schemas']['TournamentTable']
type TournamentTableUpsert = components['schemas']['TournamentTableUpsert']
type TournamentEventRead = components['schemas']['TournamentEventRead']
type TournamentEntrantRead = components['schemas']['TournamentEntrantRead']
type TournamentFixtureRead = components['schemas']['TournamentFixtureRead']
/** A slice of tables reserved for a window of time within an event — the **venue** face
 * (ticket #1369). */
type Reservation = components['schemas']['Reservation']
/** A reservation as a **write** body carries it: no `position` on either verb, and an
 * `id` only on the PATCH shape — where it *cites* a reservation the event already has
 * rather than authoring one (ADR 20260801, `api/app/tournament_reservations.py`).
 * Omitted means "add this reservation", and the server mints its uuid. */
type ReservationUpsert = components['schemas']['ReservationUpsert']
/** One row of the served **draw-type catalogue** (ADR 20260726). Its `key` is the
 * generated schema's `DrawType`, so a spec cannot serve a slug the API's enum does not
 * hold — the catalogue and the enum are the same set by construction. */
type DrawTypeRead = components['schemas']['DrawTypeRead']
type StandingsResultsRead = components['schemas']['StandingsResultsRead']
type StandingsThenFinishesResultsRead =
  components['schemas']['StandingsThenFinishesResultsRead']
type ScheduleSolveRead = components['schemas']['ScheduleSolveRead']
/** The wire's status enum — the specs drive the store with it, so it is the
 * generated schema's, not a re-typed union of four strings. */
export type TournamentStatus = TournamentDetailRead['status']
type UnreadCountResponse = components['schemas']['UnreadCountResponse']

/** Every status a tournament can be in, in lifecycle order — so a spec that
 * sweeps "each of the four" cannot quietly sweep three. This is the sweep for an
 * OWNER, who can reach all four of their own. */
export const STATUSES: readonly TournamentStatus[] = [
  'draft',
  'published',
  'live',
  'archived',
]

/** The statuses in which a tournament has been ANNOUNCED — the only statuses a
 * NON-OWNER can ever have on screen: a draft is owner-only to read, so a stranger's
 * GET of one is a 404 and the detail page never renders at all.
 *
 * The viewer sweeps run over this list rather than over `STATUSES`, because a
 * viewer + `draft` fixture would be a world the server cannot produce — the spec
 * would be stubbing a response the API refuses to give, and asserting the UI is
 * well-behaved in a state it can never be in.
 *
 * Re-exported from the mock store, NOT re-typed here: there it is derived from the
 * exhaustiveness-checked `Record<TournamentStatus, boolean>` that mirrors the API's
 * `ANNOUNCED_STATUSES` (#967), so a new status is a compile error at the source
 * instead of a sweep that silently shrinks. (The store imports only types, so
 * pulling it into the Playwright process is inert — no MSW comes with it.) */
export { ANNOUNCED_STATUSES } from '../../../src/mocks/tournaments-store'

/** The app shell's notification bell polls this on every page, tournaments
 * included. It is nothing to do with entries — but with MSW off, an unanswered
 * call falls through to the vite dev server, so the shell around the feature has
 * to be fed too. */
const UNREAD_COUNT: UnreadCountResponse = { unread_count: 0 }

/**
 * A **stateful** network stub for the tournament-entries journey, installed as
 * Playwright `page.route` interceptors (this suite runs with MSW OFF).
 *
 * Stateful is not a nicety here, it is the whole requirement: the journey is
 * enter → withdraw → **re-enter**, and each step's assertion is about what the
 * *next* read returns. A static fixture cannot express "the roster now contains
 * me and the count went up", so a spec built on one would assert the fixture,
 * not the app.
 *
 * It is a **per-test instance**, never a module singleton: the suite runs
 * `fullyParallel`, and a shared store would let one test's entry leak into
 * another's "am I entered?" join.
 *
 * The wire shapes come from the same generated-schema-typed factories the MSW
 * mocks use, so a change to the OpenAPI contract reds this file at review time
 * rather than passing a stale shape into a green spec.
 */

// A real **uuid**, not a slug: `tournament_id` is a `uuid.UUID` on the API, and
// since ADR-1001 the detail route Zod-validates the segment as one at the boundary
// (`tournaments.$tournamentId.tsx`) — a non-uuid URL throws `notFound()` before any
// fetch. A slug here (the old `bay-area-open-2026`) would make every detail
// navigation in this suite land on the not-found page instead of the tournament.
export const TOURNAMENT_ID = 'b0a1e2a0-0000-4000-8000-000000000001'

/** Type this into a venue box to make the geocode stub answer the coded 409 the
 * real provider produces for an address with zero candidates. */
export const UNRESOLVABLE_ADDRESS = '__unresolvable__'

/** The events the specs drive, named so the specs never hard-code strings that
 * must agree with the seed below. */
export const EVENT = {
  /** Singles, 2 existing entrants, 64 slots — the enter/withdraw/re-enter one. */
  JOURNEY: 'Open Singles',
  /** Singles, nobody entered — the designed *empty* roster state. */
  EMPTY: 'U1500 Singles',
  /** Doubles — the *entry-closed* roster state, and no Enter control at all. */
  DOUBLES: 'Mixed Doubles',
  /** Singles with more entrants than a card lists — the *truncated* roster.
   * Opt-in (`crowded: true`), so the default seed's counts stay the ones the
   * other specs narrate. */
  CROWDED: 'Veterans Singles',
  /** Singles, FULL of strangers (`gated: true`) — the event that explains itself
   * instead of offering an Enter that could only 409 (#783). */
  FULL: 'Masters Singles',
  /** Singles, full **including me** (`gated: true` + `enteredIn`) — the trap: an
   * entrant in a full event must still be able to WITHDRAW. */
  FULL_WITH_ME: 'Legends Singles',
  /** Singles whose one rating rule refuses me (`gated: true`) — the other event
   * that explains itself rather than offering a doomed button (#783). */
  INELIGIBLE: 'U1200 Singles',
  /** Singles in which **every** entrant is unrated (`unrated: true`) — a brand-new
   * club's first beginners' event, where nobody has finished a rated match yet. The
   * degenerate roster: every chip marked, and the list must still render (ADR-0783
   * §3). */
  ALL_UNRATED: 'Beginners Singles',
  /** The **drawable** seed's second event (`drawable: true`): singles, round-robin,
   * five entrants across two groups — the event the draw specs cut. Five and not four,
   * across two groups and not one, because that is the smallest field that puts every
   * thing a director reads a draw for on the card at once: two groups (one of 3, one of
   * 2 — the snake, not blocks), several rounds, and an ODD group, whose rounds hold
   * fewer fixtures because the player drawn against the phantom seat sits that round out
   * (ADR-0786: a bye is the ABSENCE of a fixture, and a scaffold that invented a "bye"
   * row would have to be caught here or nowhere). */
  GROUPS: 'Group Play Singles',
  /** The **bracket** seed's cuttable event (`bracket: true`): singles, `single-elim`,
   * five entrants and no groups — the one event in this suite whose draw type is not
   * round-robin, and the only user-reachable path to the stub's bracket arm.
   *
   * Five, not four or eight, because a field that is not a power of two is where a
   * bracket says something a grouped draw cannot: three of the eight slots are phantom,
   * so seeds 1–3 bye into the semifinals and **round 1 holds exactly one fixture**. A
   * planner that invented a "bye" row, or that padded round 1 to four fixtures with null
   * sides, is caught here and nowhere else (ADR-0786: a bye is the ABSENCE of a
   * fixture). */
  BRACKET: 'Championship Singles',
  /** The bracket seed's **uncuttable** event (`bracket: true`): `single-elim` with a
   * LONE entrant, who has nobody to play. It exists so the stub's single-elim refusal
   * — the `< 2 entrants` 422, the bracket twin of the group-less one — has a permanent
   * user-reachable path: without it that arm could be reverted to anything at all and
   * this suite would stay green. */
  LONE: 'Novice Singles',
  /** The **two-stage** seed's event (`twoStage: true`): singles, `rr-then-ko`, six entrants
   * across two groups, two qualifying from each (ADR 20260727). The only user-reachable path
   * to the results union's THIRD arm (`kind: "standings_then_finishes"`) in a real browser —
   * and the one that matters most, because `parseResults` **throws** on a shape it has no
   * arm for, which fails the whole query rather than degrading one panel. */
  TWO_STAGE: 'Cup Singles',
} as const

/** How many people are already in the crowded event before I enter it. Comfortably
 * past the card's 8-chip cut-off, so my own entry — appended LAST, the server lists
 * entrants oldest-entry-first — is truncated away unless the roster pins it (#781). */
const CROWD_SIZE = 12

/** The cap on the two full events. Small on purpose: "full" is `entrants.length >=
 * max_players`, and a four-seat event reaches it with a roster a human can still
 * read in a failure screenshot. */
const SMALL_CAP = 4

/** The rule the `INELIGIBLE` event is gated on, and the rating the server judged me
 * on. The client reads the rule back out of the event's own `predicates` by id, so
 * the two must be the same object — a refusal pointing at a rule the event does not
 * carry is a payload the server cannot send. */
const U1200_RULE = { id: 'pr-u1200', field: 'rating', op: '<', value: 1200 } as const

/** The rating the server judged me on — a **raw Glicko float**, because that is what
 * the server actually puts on the wire (`entry_state.rating`), thirteen decimals and
 * all. The card must print it as `1662`, like every other rating surface in the app.
 *
 * It was `1650` here, and that round number is precisely why the bug shipped: with
 * it, the rounded and unrounded renderings are the same string, so no assertion
 * anywhere — vitest or browser — could tell them apart. */
const MY_RATING = 1662.3108939062977

/** Rounded, as the UI prints it. The specs assert against THIS. */
export const MY_RATING_ROUNDED = 1662

/** `tournament_events.name` is `VARCHAR(255)` server-side, and a longer one is a
 * **422** — the other refusal QA watched the editor swallow (the sheet closed, the
 * event was never created, and the organizer's typing went with it). Mirrored here
 * so a browser spec can watch that 422 arrive and see the editor hold its ground. */
const EVENT_NAME_MAX = 255

/** The rule on the all-unrated event (`unrated: true`). The same cap as `U1200_RULE`
 * — but its entrants hold no rating at all, so every one of them *passed* it, while
 * it refuses me at 1650. That is the ADR-0783 §3 bargain in a single card, and it is
 * why the mark on those three chips is the only thing standing between the director
 * and an invisible loophole. */
const BEGINNERS_RULE = {
  id: 'pr-beg',
  field: 'rating',
  op: '<',
  value: 1200,
} as const

/**
 * ⚠️ The join key. The session payload carries a username and **no user id**, so
 * "am I entered?" is decided by matching an entrant's `username` against the
 * session's. The username the store stamps on an entry it mints MUST therefore
 * be the same one the session reports — otherwise the player enters, the roster
 * gains a stranger, Withdraw never appears, and the spec looks like an app bug.
 * One constant, used for both.
 */
export const ME = { username: 'rita.kovac', userId: 'u-me' } as const

/** Entrants that are *not* me — so the journey event starts with a real count to
 * increment, and the roster has something to show before I join it.
 *
 * **`player.2` is UNRATED** (`rating: null` — they hold no rating on the
 * tournament's ladder, ADR-0783 §3), which makes the default seed's roster a
 * *mixed* one. That is deliberate: the mark is the mitigation for a rating cap
 * being opt-out, and a mark that only ever appeared under an opt-in flag would be
 * scanned by no spec that did not go looking for it — including the axe pass over
 * the ordinary events tab. */
const OTHERS: TournamentEntrantRead[] = [
  buildTournamentEntrantRead({ id: 'entry-1', user_id: 'u-1', username: 'player.1' }),
  buildTournamentEntrantRead({
    id: 'entry-2',
    user_id: 'u-2',
    username: 'player.2',
    rating: null,
  }),
]

/** A crowd of strangers, `player.1` … `player.N`, in entry order — the roster a
 * late entrant lands behind. Rated, unless `overrides` say otherwise (which is how
 * the all-unrated event is built). */
function crowd(
  size: number,
  overrides: Partial<TournamentEntrantRead> = {},
): TournamentEntrantRead[] {
  return Array.from({ length: size }, (_, i) =>
    buildTournamentEntrantRead({
      id: `entry-crowd-${i + 1}`,
      user_id: `u-crowd-${i + 1}`,
      username: `player.${i + 1}`,
      ...overrides,
    }),
  )
}

// ----- the drawable seed (ADR-0786) ----------------------------------------
//
// A tournament whose events a draw can actually be CUT for — `drawable: true`. It
// REPLACES the entry-shaped events above rather than adding to them, and that is not a
// convenience: an event nobody has entered (`EVENT.EMPTY`) and a doubles event can never
// hold a draw that covers their entrants, so a tournament holding one can never go live,
// whatever the director does. The default seed is therefore permanently un-startable —
// which is the truth about it, and is why the go-live specs need a different tournament
// rather than a different assertion.

/** The one reservation of the drawable seed's `JOURNEY` event — and, 1:1, its one group.
 * Two entrants, one group: the smallest cuttable event there is (a group of fewer than
 * two is a 422 — a lone entrant has nobody to play). */
const JOURNEY_RESERVATIONS: Reservation[] = [
  {
    id: 'res-journey-a',
    name: 'Reservation A',
    slot: { date: '2026-06-13', start: '09:00', end: '12:30' },
    table_ids: ['t1', 't2'],
    position: 0,
  },
]

/** The two reservations of `EVENT.GROUPS` — and, 1:1, its two groups. Their ids are
 * spelled ONCE and handed to both the event and its planner: a fixture's `group_id` is a
 * string ref into its event's own `groups`, minted 1:1 from `reservations`
 * (ADR-0786 — groups are JSONB value-objects, not rows), so a seed that spelled the
 * reservation ids twice could spell them differently and every fixture would point at a
 * group that does not exist. */
const PLAY_RESERVATIONS: Reservation[] = [
  {
    id: 'res-play-a',
    name: 'Reservation A',
    slot: { date: '2026-06-13', start: '09:00', end: '11:00' },
    table_ids: ['t1', 't2'],
    position: 0,
  },
  {
    id: 'res-play-b',
    name: 'Reservation B',
    slot: { date: '2026-06-13', start: '11:00', end: '13:00' },
    table_ids: ['t3', 't4'],
    position: 1,
  },
]

/** How many players are in `EVENT.GROUPS` before anybody enters through the UI. Five
 * across two groups snakes to 3 + 2 — see `EVENT.GROUPS`. */
const PLAY_FIELD = 5

/** The field in `EVENT.BRACKET`. Five into a bracket of eight: three byes on the top
 * three seeds, one round-1 fixture, two semifinals and a final — see `EVENT.BRACKET`. */
const BRACKET_FIELD = 5

/** The played-out result for `EVENT.JOURNEY` (`standings: true`): its one group
 * (`groupIdFor('res-journey-a')`) decided, `player.1` over `player.2`, so it is complete
 * with a champion. The row entry ids are the JOURNEY event's own (`entry-1`, `entry-2`),
 * so the FE's join to a username lands — a table of raw ids would render, and prove
 * nothing. Built through the generated-schema-typed factory, so a change to the results
 * contract reds this file. */
const JOURNEY_RESULTS: StandingsResultsRead = buildEventResultsRead({
  complete: true,
  champion: 'entry-1',
  groups: [
    buildGroupStandingsRead({
      group_id: groupIdFor('res-journey-a'),
      complete: true,
      rows: [
        buildStandingRowRead({
          entry_id: 'entry-1',
          rank: 1,
          played: 1,
          wins: 1,
          losses: 0,
          games_won: 2,
          games_lost: 0,
          game_difference: 2,
        }),
        buildStandingRowRead({
          entry_id: 'entry-2',
          rank: 2,
          played: 1,
          wins: 0,
          losses: 1,
          games_won: 0,
          games_lost: 2,
          game_difference: -2,
        }),
      ],
    }),
  ],
})

// ----- the TWO-STAGE seed (`rr-then-ko`, ADR 20260727) ----------------------

/** The two reservations of `EVENT.TWO_STAGE` — and, 1:1, its two groups. Their ids are
 * `res-a` / `res-b` because `groupIdFor` derives `grp-res-a` / `grp-res-b`, which is what
 * `buildStandingsThenFinishesResultsRead`'s group blocks name — the results fixture and
 * the event's own `reservations` have to agree, or the tables would title themselves from
 * a raw id. */
const CUP_RESERVATIONS: Reservation[] = [
  {
    id: 'res-a',
    name: 'Reservation A',
    slot: { date: '2026-06-13', start: '09:00', end: '11:00' },
    table_ids: ['t1', 't2'],
    position: 0,
  },
  {
    id: 'res-b',
    name: 'Reservation B',
    slot: { date: '2026-06-13', start: '11:00', end: '13:00' },
    table_ids: ['t3', 't4'],
    position: 1,
  },
]

/** The two-stage event's field: six entrants with **plain** ids (`entry-1`…`entry-6`), not
 * the `crowd()` helper's `entry-crowd-N`, because the results fixture names entries by those
 * plain ids — and an id the event does not list joins to "Withdrawn", which is exactly the
 * bug a browser spec about names is meant to catch. */
const CUP_ENTRANTS: TournamentEntrantRead[] = Array.from({ length: 6 }, (_, i) =>
  buildTournamentEntrantRead({
    id: `entry-${i + 1}`,
    user_id: `u-cup-${i + 1}`,
    username: `player.${i + 1}`,
  }),
)

/** The played-out two-stage result for `EVENT.TWO_STAGE`: both groups decided, the
 * bracket run to a final, and a champion — `player.4` — who **tops neither group**. The
 * snake deals `groupIdFor('res-a')` entries 1, 4, 5 and `groupIdFor('res-b')` entries 2,
 * 3, 6, and the fixture's standings stand over exactly those memberships.
 *
 * The factory's own default `groups` name `grp-a`/`grp-b` literally — fine for a fixture
 * with no real event behind it, but this one has to agree with `CUP_RESERVATIONS`' real
 * derived group ids, so both groups are overridden here with the same rows, `group_id`
 * swapped for `groupIdFor(...)`. */
const CUP_RESULTS: StandingsThenFinishesResultsRead =
  buildStandingsThenFinishesResultsRead({
    groups: [
      buildGroupStandingsRead({
        group_id: groupIdFor('res-a'),
        complete: true,
        rows: [
          buildStandingRowRead({
            entry_id: 'entry-1',
            rank: 1,
            played: 2,
            wins: 2,
            losses: 0,
            games_won: 4,
            games_lost: 1,
            game_difference: 3,
          }),
          buildStandingRowRead({
            entry_id: 'entry-4',
            rank: 2,
            played: 2,
            wins: 1,
            losses: 1,
            games_won: 3,
            games_lost: 3,
            game_difference: 0,
          }),
          buildStandingRowRead({
            entry_id: 'entry-5',
            rank: 3,
            played: 2,
            wins: 0,
            losses: 2,
            games_won: 1,
            games_lost: 4,
            game_difference: -3,
          }),
        ],
      }),
      buildGroupStandingsRead({
        group_id: groupIdFor('res-b'),
        complete: true,
        rows: [
          buildStandingRowRead({
            entry_id: 'entry-2',
            rank: 1,
            played: 2,
            wins: 2,
            losses: 0,
            games_won: 4,
            games_lost: 0,
            game_difference: 4,
          }),
          buildStandingRowRead({
            entry_id: 'entry-3',
            rank: 2,
            played: 2,
            wins: 1,
            losses: 1,
            games_won: 2,
            games_lost: 3,
            game_difference: -1,
          }),
          buildStandingRowRead({
            entry_id: 'entry-6',
            rank: 3,
            played: 2,
            wins: 0,
            losses: 2,
            games_won: 1,
            games_lost: 4,
            game_difference: -3,
          }),
        ],
      }),
    ],
  })

/** The same event one match from home: groups decided, the final seated and unplayed. So
 * `complete` is false, there is no champion, and the finishes list **starts at position 3**
 * — the two beaten semifinalists are all the bracket has placed. */
const CUP_RESULTS_MID_FLIGHT: StandingsThenFinishesResultsRead =
  buildStandingsThenFinishesResultsRead({
    groups: CUP_RESULTS.groups,
    complete: false,
    champion: null,
    finishes: CUP_RESULTS.finishes.filter((f) => f.position === 3),
  })

/** The two-stage event (`twoStage: true`), added to the drawable seed rather than replacing
 * it — opt-in for the same reason `bracket` is: its six entrants would move the
 * tournament-level Entries total the journey spec narrates. */
function twoStageEvents(): TournamentEventRead[] {
  return [
    buildTournamentEventRead({
      id: 'ev-cup',
      name: EVENT.TWO_STAGE,
      format: 'singles',
      draw_type: 'rr-then-ko',
      // The director's own K, which sizes the bracket at the cut (`P × K` = 2 × 2 = 4).
      qualifiers_per_group: 2,
      max_players: 32,
      entrants: CUP_ENTRANTS,
      reservations: CUP_RESERVATIONS,
    }),
  ]
}

/** The round-robin tournament: two events, both cuttable, nothing cut yet. `drawn`
 * decides which of them arrive with a draw already standing.
 *
 * `JOURNEY` keeps its name, its cap and its two entrants, so the lifecycle specs' count
 * assertions (`2 / 64` → `3 / 64`) read the same here as in the default seed — the one
 * thing that changes about it is that its draw type is now one a draw can be cut for. */
function drawableEvents(options: TournamentsStoreOptions): TournamentEventRead[] {
  return [
    buildTournamentEventRead({
      id: 'ev-open-singles',
      name: EVENT.JOURNEY,
      format: 'singles',
      draw_type: 'round-robin',
      max_players: 64,
      entrants: OTHERS,
      reservations: JOURNEY_RESERVATIONS,
    }),
    buildTournamentEventRead({
      id: 'ev-group-play',
      name: EVENT.GROUPS,
      format: 'singles',
      draw_type: 'round-robin',
      max_players: 32,
      entrants: crowd(PLAY_FIELD),
      reservations: PLAY_RESERVATIONS,
    }),
    ...(options.bracket ?? false ? bracketEvents() : []),
    ...(options.twoStage ?? false ? twoStageEvents() : []),
  ]
}

/** The two `single-elim` events (`bracket: true`) — one cuttable, one refused. Opt-in,
 * and added to the drawable seed rather than replacing it, because every count the
 * lifecycle and go-live specs narrate is asserted against that seed's two round-robin
 * events: a third and fourth event in the DEFAULT seed would move the tournament's
 * Entries total and the work list a refused start prints.
 *
 * They are **UNGROUPED**. A bracket ignores its event's reservations entirely — on the
 * server and in `planDraw` alike — so giving them reservations would suggest a
 * relationship that does not exist. It also keeps `EVENT.LONE`'s refusal honest: the one
 * thing wrong with it is its field of one, so the sentence it gets back can only be the
 * bracket's. */
function bracketEvents(): TournamentEventRead[] {
  return [
    buildTournamentEventRead({
      id: 'ev-championship',
      name: EVENT.BRACKET,
      format: 'singles',
      draw_type: 'single-elim',
      max_players: 32,
      entrants: crowd(BRACKET_FIELD),
      reservations: [],
    }),
    buildTournamentEventRead({
      id: 'ev-novice',
      name: EVENT.LONE,
      format: 'singles',
      draw_type: 'single-elim',
      max_players: 16,
      entrants: crowd(1),
      reservations: [],
    }),
  ]
}

/** The `address` the seed carries, as a spread — three cases, and each has to be
 * expressible independently of the factory's default:
 *
 * - nothing spread in → the factory's Berkeley venue,
 * - `{ address: null }` → the tournament with NO venue (CONTEXT.md, "Venue"),
 * - `{ address: {…, venue: <680 unbroken chars> } }` → the pathological row the
 *   layout has to survive (#1199). It keeps the Berkeley coordinates and the rest
 *   of the components, so the ONLY thing that differs from the happy path is the
 *   length of one string — which is what makes an overflow measured against it
 *   attributable.
 *
 * `venueless` wins if both are passed: "there is no venue" is not a venue name.
 */
function addressOverride(
  options: TournamentsStoreOptions,
): Partial<Pick<TournamentDetailRead, 'address'>> {
  if (options.venueless ?? false) return { address: null }
  if (!(options.longVenue ?? false)) return {}
  const { address } = buildTournamentDetailRead()
  // The factory's default address is never null; narrow rather than assert.
  if (!address) return {}
  return { address: { ...address, venue: UNBREAKABLE_VENUE_NAME } }
}

/** The tournament's `name`, as a spread — the factory's "Bay Area Open 2026" by
 * default, and `UNBREAKABLE_TOURNAMENT_NAME` under `longName`.
 *
 * A spread rather than a ternary at each call site because `seed` returns from two
 * places, and an override wired into only one of them would be silently dead for
 * any spec that combined `longName` with `drawable`.
 *
 * The name lands in THREE boxes at once — the `h1`, the last breadcrumb crumb and
 * the confirm dialog's copy — which is why the spec that uses it names each box it
 * measures rather than only the document.
 */
function nameOverride(
  options: TournamentsStoreOptions,
): Partial<Pick<TournamentDetailRead, 'name'>> {
  if (!(options.longName ?? false)) return {}
  return { name: UNBREAKABLE_TOURNAMENT_NAME }
}

/** All three roster states (`listed` / `empty` / `entry-closed`) on one page, on
 * purpose: it is the real shape of an Events tab, and it lets one axe scan cover
 * every state the roster can be in.
 *
 * The fourth — a roster *longer than the card lists* — is opt-in (`crowded`),
 * because its dozen entrants would move the tournament-level Entries total that
 * the journey spec asserts on. */
function seed(options: TournamentsStoreOptions): TournamentDetailRead {
  const crowded = options.crowded ?? false
  // The catalogue the DETAIL payload carries (ADR 20260726) — the rows the picker
  // renders. It defaults to the factory's, which is a verbatim copy of the migration's
  // seed, so the default is what the real server sends; a spec overrides it to prove the
  // picker follows the *payload* rather than a list of its own.
  const draw_type_catalogue = options.drawTypeCatalogue ?? DRAW_TYPE_CATALOGUE
  const address = addressOverride(options)
  const name = nameOverride(options)
  // `bracket` IMPLIES `drawable`: the bracket events extend the round-robin seed, and a
  // `{ bracket: true }` that quietly seeded the default tournament instead would be a
  // spec asserting against events that are not there — a silent no-op, not a red.
  if ((options.drawable ?? false) || (options.bracket ?? false)) {
    return buildTournamentDetailRead({
      id: TOURNAMENT_ID,
      status: options.status ?? 'published',
      can_edit: options.canEdit ?? true,
      draw_type_catalogue,
      ...address,
      ...name,
      events: drawableEvents(options),
    })
  }
  return buildTournamentDetailRead({
    id: TOURNAMENT_ID,
    status: options.status ?? 'published',
    can_edit: options.canEdit ?? true,
    draw_type_catalogue,
    ...address,
    ...name,
    events: [
      buildTournamentEventRead({
        id: 'ev-open-singles',
        name: EVENT.JOURNEY,
        format: 'singles',
        max_players: 64,
        entrants: OTHERS,
      }),
      buildTournamentEventRead({
        id: 'ev-u1500',
        name: EVENT.EMPTY,
        format: 'singles',
        // The **refusal** fixture: a round-robin with NO RESERVATIONS (and so no
        // groups), which is a 422 the real API genuinely emits ("A round-robin draw
        // needs at least one group."). Both halves are stated here rather than
        // inherited, because the refusal specs rest on exactly this pair — a stub that
        // refused a draw type the server can in fact cut (single-elim shipped in #785)
        // would be asserting a sentence no server would ever send, which is the one
        // thing a mirror of the API must not do.
        draw_type: 'round-robin',
        max_players: 48,
        entrants: [],
        reservations: [],
      }),
      buildTournamentEventRead({
        id: 'ev-mixed-doubles',
        name: EVENT.DOUBLES,
        format: 'doubles',
        max_players: 32,
        entrants: [],
        reservations: [],
      }),
      ...(crowded
        ? [
            buildTournamentEventRead({
              id: 'ev-veterans',
              name: EVENT.CROWDED,
              format: 'singles',
              max_players: 64,
              entrants: crowd(CROWD_SIZE),
              reservations: [],
            }),
          ]
        : []),
      ...(options.unrated ?? false
        ? [
            buildTournamentEventRead({
              id: 'ev-beginners',
              name: EVENT.ALL_UNRATED,
              format: 'singles',
              max_players: 32,
              // Every one of them holds no rating on the tournament's ladder — so
              // every one of them PASSED this event's `rating < 1200` rule, which is
              // exactly the opt-out ADR-0783 accepts and this roster exists to
              // expose. Meanwhile the same rule refuses *me*, at a rating of 1650:
              // the whole decision, on one card. Three players the rules could not
              // judge are in; the one player they could judge is out.
              entrants: crowd(3, { rating: null }),
              predicates: [{ ...BEGINNERS_RULE }],
              entry_state: {
                state: 'rating_ineligible',
                predicate_id: BEGINNERS_RULE.id,
                rating: MY_RATING,
              },
              reservations: [],
            }),
          ]
        : []),
      ...(options.gated ?? false ? gatedEvents() : []),
    ],
  })
}

/** The two events the *event itself* refuses the caller from (#783) — full, and
 * rating-ineligible. Opt-in (`gated: true`) for the same reason `crowded` is: their
 * entrants would move the tournament-level Entries total the journey spec narrates.
 *
 * `entry_state` on the full pair is **derived** by the factory from the entrants
 * (and re-derived on every read — see `read`), so entering or withdrawing really
 * does flip it; the ineligible one is stated, because no mock payload carries a
 * rating ladder to judge it from. */
function gatedEvents(): TournamentEventRead[] {
  return [
    buildTournamentEventRead({
      id: 'ev-masters',
      name: EVENT.FULL,
      format: 'singles',
      max_players: SMALL_CAP,
      entrants: crowd(SMALL_CAP),
      reservations: [],
    }),
    buildTournamentEventRead({
      id: 'ev-legends',
      name: EVENT.FULL_WITH_ME,
      format: 'singles',
      max_players: SMALL_CAP,
      // One seat short of full — the spec fills it with ME (`enteredIn`), which is
      // the only honest way to reach "an entrant inside a FULL event".
      entrants: crowd(SMALL_CAP - 1),
      reservations: [],
    }),
    buildTournamentEventRead({
      id: 'ev-u1200',
      name: EVENT.INELIGIBLE,
      format: 'singles',
      max_players: 24,
      entrants: crowd(2),
      predicates: [{ ...U1200_RULE }],
      entry_state: {
        state: 'rating_ineligible',
        predicate_id: U1200_RULE.id,
        rating: MY_RATING,
      },
      reservations: [],
    }),
  ]
}

export interface TournamentsStoreOptions {
  /** The signed-in player's permissions. Defaults to a beta tester (can enter).
   * Pass `[PERM.TOURNAMENT_VIEW]` for the "no Enter control" case. */
  permissions?: string[]
  /** Add `EVENT.CROWDED` — a singles event already holding more entrants than a
   * card can list, so entering it puts me past the truncation cut-off. */
  crowded?: boolean
  /** Add the three events the *event itself* gates (#783): `EVENT.FULL`,
   * `EVENT.FULL_WITH_ME` and `EVENT.INELIGIBLE`. Opt-in, so their entrants stay out
   * of the counts the journey spec narrates. */
  gated?: boolean
  /** Add `EVENT.ALL_UNRATED` — a capped event whose entrants are *every one* of
   * them unrated (ADR-0783 §3). Opt-in for the same reason `crowded` is: its
   * entrants would move the tournament-level Entries total. (The *mixed* roster
   * needs no flag — `player.2` of the default seed is unrated.) */
  unrated?: boolean
  /** The status the tournament is in when the page loads. Defaults to
   * `published` — the one status whose registration window is OPEN, and the one
   * every enter/withdraw spec is written against (ADR-0017). */
  status?: TournamentStatus
  /** Does the signed-in player own it? Defaults to `true` (the owner, who is
   * offered the lifecycle buttons). `false` is the viewer: same page, no
   * transitions — the server 403s them, so the UI must not offer them. */
  canEdit?: boolean
  /** Serve the tournament with **no venue** — `address: null` (CONTEXT.md,
   * "Venue"), the state of one announced before its room is booked, or one at
   * somebody's home whose address is deliberately withheld. Defaults to `false`
   * (the seeded Berkeley venue).
   *
   * It is opt-in and stubbed HERE rather than asserted in vitest alone, because
   * with MSW off this suite is the only place the real fetch stack decodes a
   * `null` address off the wire — the generated schema made it nullable, and a
   * page-object stub that could not produce one would leave that untested. */
  venueless?: boolean
  /** Serve the tournament with a **680-character venue name and no break
   * opportunity in it** (`UNBREAKABLE_VENUE_NAME`) — the row that made the detail
   * page scroll sideways (#1199).
   *
   * It has to be an e2e option and not a vitest fixture alone, because the claim
   * is about **layout**: jsdom performs none, so `scrollWidth`/`clientWidth` are
   * `0` there and an overflow assertion passes whether the page wraps, truncates,
   * or runs 2000px off the right-hand edge. Only a browser can tell those apart.
   *
   * Ignored when `venueless` is set. */
  longVenue?: boolean
  /** Serve the tournament with a **255-character name and no break opportunity in
   * it** (`UNBREAKABLE_TOURNAMENT_NAME`) — the hostile title the mobile header has
   * to survive (#1044).
   *
   * Opt-in and off by default, like `crowded`, `gated`, `unrated`, `venueless` and
   * `longVenue`: the tournament's name is copy that existing specs read back (the
   * breadcrumb, the confirm dialogs, the page title), so a changed default would
   * red them.
   *
   * It has to be an e2e option rather than a vitest fixture alone, because the
   * claim is about **layout**. jsdom performs none, so `scrollWidth` and
   * `clientWidth` are `0` there and a wrap assertion passes whether the title
   * wraps, truncates, or collapses to one glyph per line. */
  longName?: boolean
  /** Events ME is already entered in when the page loads — by event name. The
   * only way to reach "an entered player on a *live* tournament", since entering
   * one through the UI is (rightly) refused. */
  enteredIn?: string[]
  /** Seed the **round-robin** tournament instead of the entry-shaped one (ADR-0786):
   * `EVENT.JOURNEY` and `EVENT.GROUPS`, both of them events a draw can be cut for.
   *
   * It REPLACES the default events rather than adding to them — see `drawableEvents`.
   * The default seed holds an event with no entrants and a doubles event, and no draw
   * can ever cover either, so that tournament can never go live: a spec about the draw,
   * or about starting a tournament, needs a tournament that *could* be started. */
  drawable?: boolean
  /** Add the two **single-elimination** events to the drawable seed — which it also
   * turns on, since it extends that seed rather than the default one: `EVENT.BRACKET`,
   * which cuts into a real bracket, and `EVENT.LONE`, which is refused for a field of
   * one.
   *
   * Opt-in for the same reason `crowded` and `gated` are — its entrants would move the
   * tournament-level Entries total the journey spec narrates, and a third and fourth
   * uncut event would lengthen the work list a refused go-live prints. It is also the
   * ONLY path in this suite to `planDraw`'s `single-elim` arm: without it that arm could
   * be reverted to a refusal and every spec here would stay green. */
  bracket?: boolean
  /** The **draw-type catalogue** the detail payload carries (ADR 20260726) — the rows
   * the event editor's draw-type picker renders, and the only source of the labels a
   * director reads.
   *
   * Defaults to the factory's `DRAW_TYPE_CATALOGUE`, which mirrors the migration's seed.
   * A spec overrides it to prove the picker is following *this payload*: an assertion
   * against the seeded labels alone would pass just as happily against a client that
   * still kept a hardcoded list, which is the thing the ADR deleted. */
  drawTypeCatalogue?: DrawTypeRead[]
  /** Events whose draw is already CUT when the page loads — by name, and only from the
   * drawable seed (the default seed's events are group-less or empty, and the stub refuses
   * to cut those exactly as the server does).
   *
   * Cut with the same planner the cut ROUTE uses, from the same entrants and the same
   * reservations, so a seeded draw is one this stub could have dealt — never a hand-written
   * list of fixtures no cut would ever produce. */
  drawn?: string[]
  /** Attach a **played-out** result to `EVENT.JOURNEY` (ADR-0788): its one group decided,
   * with a champion — the standings the tournament detail renders once matches complete.
   * Opt-in, and only meaningful with `drawable`, because standings ride on a round-robin
   * event's draw. Its rows name the drawable JOURNEY's own two entrants (`entry-1`,
   * `entry-2`), so the FE's name join lands. */
  standings?: boolean
  /** Add the **two-stage** (`rr-then-ko`) event to the drawable seed — which it also turns
   * on, since it extends that seed: `EVENT.TWO_STAGE`, six entrants across two groups.
   *
   * Opt-in for the same reason `bracket` is (its entrants would move the Entries total the
   * journey spec narrates), and it is the ONLY browser-reachable path to the results union's
   * third arm. Pair it with `twoStageResults` to attach a played-out or mid-flight result;
   * on its own it is an uncut two-stage event. */
  twoStage?: boolean
  /** Attach the **two-stage** result to `EVENT.TWO_STAGE` (ADR 20260727) — `'complete'` for
   * a bracket run to a final with a champion, `'mid-flight'` for decided groups and an
   * unplayed final (no champion, finishes starting at position 3). Only meaningful with
   * `twoStage`. */
  twoStageResults?: 'complete' | 'mid-flight'
  /** The tournament's latest **schedule solve** ledger row when the page loads (ADR
   * "the schedule is solved") — how a spec starts on a `succeeded`, `infeasible` or
   * `failed` strip without walking the whole run. Built with
   * `buildScheduleSolveRead(...)`, the same generated-schema-typed factory the MSW
   * mocks use, so a contract change reds this file. Defaults to `null` — no solve
   * ever requested, the state every tournament is born in. */
  latestSolve?: ScheduleSolveRead
  /** Place an event's **first fixture** at the catalogue's first table before the page
   * loads — the state that makes removing that table a **409** (ADR 20260801).
   *
   * Seeded rather than driven through the Schedule tab because the claim under test is
   * the Tables tab's, not the scheduler's: a spec that had to place a match through the
   * UI first would red for a scheduling regression and read as a tables bug. Only
   * meaningful with `drawn` — a fixture has to exist to be placed. */
  placed?: string
}

/** The options for a tournament that can actually be **started**: every event drawable,
 * and every draw cut. Exported as one constant rather than re-typed per spec, because it
 * is a *rule* and not a preference — go-live refuses a tournament with an event whose
 * draw is missing (ADR-0786), so a spec that wanted to walk the lifecycle and named only
 * one of the two events would be refused, and would look like a bug in the header. */
export const READY_TO_START: TournamentsStoreOptions = {
  drawable: true,
  drawn: [EVENT.JOURNEY, EVENT.GROUPS],
}

/**
 * The lifecycle's edge table, mirroring the server's `LEGAL_TRANSITIONS`
 * (`api/app/tournaments.py`, ADR-0017): the three forward edges are the whole
 * rule, and **every other (from, to) pair is a 409** — backwards, skipping a
 * stage, out of the terminal `archived`, and re-asserting the status a
 * tournament already holds.
 *
 * It is written out as pairs rather than derived from the client's own
 * `LIFECYCLE_EDGE`: a stub that imported the app's table could never disagree
 * with it, so a spec built on one would prove the app consistent with itself
 * instead of consistent with the server.
 */
const LEGAL_TRANSITIONS: ReadonlyArray<readonly [TournamentStatus, TournamentStatus]> =
  [
    ['draft', 'published'],
    ['published', 'live'],
    ['live', 'archived'],
  ]

/** Why registration is refused, in the API's exact words
 * (`_registration_closed_detail`). `published` is absent because it is the one
 * status that refuses nothing. */
const REGISTRATION_CLOSED_DETAIL: Record<
  Exclude<TournamentStatus, 'published'>,
  string
> = {
  draft:
    'This tournament has not been published yet, so its events are not open for entry.',
  live: 'This tournament is already under way, so its entries are locked.',
  archived: 'This tournament has ended, so its events can no longer be entered.',
}

// ----- the draw, and the go-live precondition it gates (ADR-0786) -----------
//
// ⚠️ This stub used to be **more permissive than the server** in two ways at once, and
// each of them would have let a lying UI ship: every event's `fixtures` defaulted to
// `[]` (so no browser spec could ever reach a *drawn* state — the groups scaffold, the
// frozen editor and the axe scan over both were unreachable), and `published → live` was
// accepted unconditionally (so the precondition the server enforces could not be
// exercised, and a Start button that worked here would 409 in front of a director on the
// morning of their tournament). Both are closed below, with the server's own rules and
// the server's own sentences — the copy is what the director reads.

/** Where one event's draw stands (`DrawCurrency`, `api/app/tournament_draws.py`).
 *
 * A **set comparison, never a count**: currency is "these fixtures seat exactly these
 * entrants". Sizes agreeing would wave through the case that matters most — one player
 * withdraws and another enters between the cut and go-live, leaving the same count, a
 * different field, and a draw that seats somebody who has left while their replacement is
 * seated nowhere. */
function drawCurrency(event: TournamentEventRead): 'current' | 'uncut' | 'stale' {
  // Decided on the fixtures EXISTING, not on the seated set being empty: an event nobody
  // has entered has neither, and ∅ == ∅ would call it `current` — an event with no draw
  // at all, certified ready to start.
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

/** The things a refusal is about, as a human would say them: `“Group B”`, or
 * `“Group B” and “Group C”` (`named_list`, `api/app/schemas/tournament.py`). */
function namedList(names: string[]): string {
  const quoted = names.map((name) => `“${name}”`)
  if (quoted.length === 1) return quoted[0]
  return `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`
}

/**
 * The server's sentence for a catalogue edit that would remove a table matches are
 * placed at (`_tables_in_use_detail`, `api/app/tournament_tables.py`) — **verbatim**,
 * because the confirm dialog renders it verbatim.
 *
 * Written out here rather than imported from the app: a stub that read its refusal out
 * of the client's own copy could never disagree with it, so a spec built on one would
 * prove the app consistent with itself instead of consistent with the server. It names
 * the tables by LABEL, never by id, and it names both ways out — send the same edit
 * again with the opt-in, or move the matches off the table first.
 */
export function tablesInUseDetail(labels: string[], placements: number): string {
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

/** The server's sentence for a tournament with nothing to run. */
const NOTHING_TO_START =
  'This tournament has no events, so there is nothing to start. Add an event and cut ' +
  'its draw, then start the tournament.'

/** Why this tournament cannot start yet, in the server's own words — or `null` when it
 * can (`_enforce_ready_to_go_live`). **It names the events**, and the two failures are
 * kept apart in the sentence because they are two different jobs: an uncut event needs a
 * first cut, while a stale one has a draw the director may well have reviewed and merely
 * needs to re-cut. */
function goLiveRefusal(tournament: TournamentDetailRead): string | null {
  if (tournament.events.length === 0) return NOTHING_TO_START

  const uncut: string[] = []
  const stale: string[] = []
  for (const event of tournament.events) {
    const currency = drawCurrency(event)
    if (currency === 'uncut') uncut.push(event.name)
    else if (currency === 'stale') stale.push(event.name)
  }
  if (uncut.length === 0 && stale.length === 0) return null

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
    'This tournament cannot start yet: ' +
    clauses.join('; and ') +
    '. A draw is cut from the field as it stands at the time, and registration stays ' +
    'open right up to the moment a tournament goes live — so cut the draw for each ' +
    'event named (again, if somebody entered or withdrew since it was last cut), then ' +
    'start the tournament.'
  )
}

/** The server's sentence for a draw that has been played (`_enforce_draw_unplayed`).
 * Unreachable from a browser today — nothing in the client materializes a fixture into a
 * match (#788) — and mirrored anyway, because the guard is what the panel's 409 copy is
 * written against, and a stub that answered **201** here would be the stub quietly being
 * more permissive than the server. */
const DRAW_UNDER_WAY_DETAIL =
  "This event's draw is already under way — at least one fixture has a match " +
  'or a recorded winner — so it can no longer be cut or removed.'

/** Materialize an event's ready fixtures into real **`in_progress` matches** — the
 * go-live step (#788, `api/app/tournaments.py`), mirroring the MSW store's
 * `materializeFixtures`: a fixture is ready when both its sides are known (a TBD side
 * waits), and the mint is idempotent on `match_id`. The match id is deterministic off
 * the fixture, so the same draw materializes the same way every run.
 *
 * ⚠️ This stub used to OMIT the step, and the omission was load-bearing: a live seed's
 * fixtures stayed matchless, every pinned fixture kept tier `called`, and the board
 * specs went green against a world the server never serves — live round-robin fixtures
 * are `in_progress` from the first second, and the QA pass caught the real board hiding
 * every called badge behind exactly that status. */
function materializeFixtures(event: TournamentEventRead): TournamentEventRead {
  const fixtures = event.fixtures.map((fixture) => {
    const ready = fixture.entry_a_id !== null && fixture.entry_b_id !== null
    if (!ready || fixture.match_id !== null) return fixture
    return {
      ...fixture,
      match_id: `m-${fixture.id}`,
      match_status: 'in_progress' as const,
    }
  })
  return { ...event, fixtures }
}

/** Evidence of play: a fixture with a recorded winner, or one that has become a real
 * match. */
function drawHasPlay(event: TournamentEventRead): boolean {
  return event.fixtures.some(
    (f) => f.winner_entry_id !== null || f.match_id !== null,
  )
}

/** The entrants in **draw order** — seed ascending where one is set, then registration
 * order (ADR-0786) — which is the list the planner is handed. A stable sort over the
 * stub's own (registration-ordered) list. */
function drawOrder(entrants: TournamentEntrantRead[]): TournamentEntrantRead[] {
  return [...entrants].sort(
    (a, b) =>
      (a.seed ?? Number.MAX_SAFE_INTEGER) - (b.seed ?? Number.MAX_SAFE_INTEGER),
  )
}

/** Plan an event's draw exactly as the cut route does — from its entrants in draw order —
 * or say why it cannot be. Used for BOTH the seeded draws (`drawn`) and the route, so a
 * fixture on screen is always one this stub could have dealt.
 *
 * The decision itself — which draws are refused, and the server's own sentences for
 * refusing them (`app/draws.py`, where for these 422s the sentence IS the answer) — is
 * `planDraw` in `src/mocks/factories/tournaments/tournament.factory.ts`, shared with the
 * MSW store. It used to be copied here, and that copy could not be trusted to stay in
 * step: `tsconfig.app.json` includes only `src`, so no `tsc -b` ever reads this directory
 * and Playwright transforms it without typechecking — its exhaustive `switch` over
 * `DrawType` had no compile-time guarantee at all, and a new member would have red in the
 * `src` store while silently falling through here. Behind the one checked declaration,
 * both stubs get that guarantee. What is left local is only how a row is read into the
 * planner's arguments. */
function planEventDraw(event: TournamentEventRead): DrawPlan {
  return planDraw(
    event.draw_type,
    drawOrder(event.entrants).map((e) => e.id),
    event.groups.map((g) => g.id),
    // **The event's own K** (ADR 20260727) — the count the director configured and the
    // PATCH stored, passed through unchanged. It is what sizes an `rr-then-ko` draw's
    // bracket (`P × K`), so substituting anything would cut a `P × 1` bracket for an event
    // configured otherwise: a well-formed draw of the wrong size, with nothing anywhere
    // reporting the substitution. `null` is the honest value for a count-less draw type,
    // and only the arm that never reads it can see it.
    event.qualifiers_per_group,
    // **The event's own R** (ADR "swiss pre-cuts every round and pairs each one on
    // advance") — the round count the director configured and the PATCH stored, passed
    // through unchanged and on exactly the same terms as the qualifier count above: it is
    // what sizes a swiss draw (`R × ⌊n/2⌋` fixtures, all written at the cut), so a
    // substitution here would deal a swiss of the wrong length with nothing reporting it.
    // `null` is the honest value for the three draw types that choose no round count.
    event.rounds,
    // **The event's own stages** (ADR 20260815) — never `planDraw`'s
    // `mintStageReads(drawType)` default, which is for a caller with no event to read
    // stages off of. A fixture this cuts must name a stage `event.stages` actually holds.
    event.stages,
  )
}

/** The server's sentence for a reservations payload that would change WHICH groups a cut
 * event has (`_group_set_frozen_detail`, `api/app/tournament_events.py`) — verbatim,
 * because the editor shows it verbatim in its inline banner.
 *
 * Both halves are named from whichever side of the change still knows the label: a
 * group being removed is described by the POSITION the row the event holds already
 * stands at; one being added is described by the position it would land at — its own
 * index in the incoming array, since it has no group yet. */
function groupSetFrozenDetail(
  event: TournamentEventRead,
  submitted: { id?: string | null; name?: string }[],
): string {
  const existing = new Set(event.reservations.map((r) => r.id))
  const incoming = new Set(
    submitted.map((r) => r.id).filter((id): id is string => id != null),
  )
  const clauses: string[] = []
  const removed = event.reservations
    .map((r, position) => ({ r, position }))
    .filter(({ r }) => !incoming.has(r.id))
    .map(({ position }) => `Group ${groupLetter(position)}`)
  const added = submitted
    .map((r, position) => ({ r, position }))
    .filter(({ r }) => r.id == null || !existing.has(r.id))
    .map(({ position }) => `Group ${groupLetter(position)}`)
  if (removed.length > 0) {
    clauses.push(
      `${namedList(removed)} already has fixtures drawn into it, ` +
        'which this change would leave pointing at a group that no longer exists',
    )
  }
  if (added.length > 0) {
    clauses.push(
      `${namedList(added)} would arrive with no fixtures in it, ` +
        'because the draw was cut across the groups this event had at the time',
    )
  }
  return (
    "This event's draw is already cut, so its set of groups is frozen: " +
    clauses.join('; and ') +
    ". A reservation's tables, its time and its name can all still be changed. " +
    'To add or remove a group, remove the draw first, then cut it again.'
  )
}

/** Why this event PATCH is refused by a standing draw — or `null` when it is not
 * (`_enforce_group_set_frozen` / `_enforce_draw_type_frozen`, both a 409).
 *
 * Two facts are frozen while fixtures exist, and **only** these two:
 * - the **set of groups**, because a fixture names the group it was dealt into — remove
 *   the reservation that mints one and its fixtures point at nothing, add a reservation
 *   and its new group arrives with no fixtures;
 * - the **draw type**, because it is not a label on an event but the strategy that DEALT
 *   these fixtures.
 *
 * Everything else about a reservation — its name, its tables, its window, its place in
 * the order — stays editable, and so does the rest of the event.
 *
 * **Re-identifying a reservation is no longer one of the refusals**, because it is no
 * longer a payload a client can send (ADR 20260801): a reservation id is minted by the
 * server, so an entry either cites one this event has or carries none at all — and an
 * entry with no id is an *addition*, which is why it counts towards the change rather
 * than towards the incoming set. */
function frozenDetail(event: TournamentEventRead, body: unknown): string | null {
  if (event.fixtures.length === 0) return null
  const patch = body as {
    reservations?: { id?: string | null }[] | null
    draw_type?: string | null
  } | null

  if (patch?.reservations) {
    const before = new Set(event.reservations.map((r) => r.id))
    const after = new Set(
      patch.reservations.map((r) => r.id).filter((id): id is string => id != null),
    )
    const same =
      before.size === after.size &&
      after.size === patch.reservations.length &&
      [...before].every((id) => after.has(id))
    if (!same) return groupSetFrozenDetail(event, patch.reservations)
  }

  if (patch?.draw_type && patch.draw_type !== event.draw_type) {
    return (
      "This event's draw is already cut, so its draw type is frozen: its fixtures were " +
      `dealt as a “${event.draw_type}” draw, and changing the type would leave the event ` +
      'claiming a shape its draw does not have. To change the draw type, remove the draw ' +
      'first, then cut it again.'
    )
  }

  return null
}

interface RecordedRequest {
  method: string
  path: string
}

export class TournamentsStore {
  private detail: TournamentDetailRead
  private entryCounter = 0
  private tableCounter = 0
  private reservationCounter = 0
  private gate: Promise<void> | null = null
  private refusingWrites = false
  private refusingTournamentCreate = false
  private faultingWrites = false
  private faultingTournamentCreate = false

  /** Every intercepted request, for tallies like "exactly one POST landed". */
  readonly requests: RecordedRequest[] = []
  /** Requests this store has no route for. A spec asserts this stays empty — an
   * unmocked call would otherwise fall through to a 404 and be read as an app
   * bug (or, without the catch-all, get `index.html` back from vite). */
  readonly unhandled: RecordedRequest[] = []
  /** Every `POST /v1/tournaments` body, in order — what the dialog actually PUT ON
   * THE WIRE, as opposed to what a component test saw it hand its callback.
   *
   * It exists for the venue: a tournament created with the venue boxes empty must
   * send `address: null` (CONTEXT.md, "Venue"), and the only way to see that six
   * empty strings did not go instead is to read the serialized body. */
  readonly createBodies: TournamentCreate[] = []
  /** Every `PATCH /v1/tournaments/{id}` body, in order — what the Tables tab actually
   * PUT ON THE WIRE.
   *
   * It exists for the id: a new table must be sent with **no `id` at all** (the server
   * mints them, ADR 20260801), and a component test can only see the callback's
   * argument. Only the serialized body can show that a client-minted id did not go —
   * and only here, with MSW off, does the real `openapi-fetch` do the serializing. */
  readonly patchBodies: TournamentUpdate[] = []

  constructor(private readonly options: TournamentsStoreOptions = {}) {
    this.detail = seed(options)
    // Seeded entries bypass the status gate on purpose: they are entries the
    // player made while the window was open, and the tournament has moved on
    // since. That is the only way a `live` tournament can hold an entrant of
    // mine — which is exactly the state the "locked, not Withdraw" case is about.
    for (const name of options.enteredIn ?? []) {
      this.addEntry(this.eventNamed(name).id)
    }
    // The seeded draws (`drawn`) are cut AFTER the seeded entries, and through the same
    // planner the route uses: a draw is a plan made against the field as it stands, so
    // one cut before those entries landed would be born stale — and a spec that meant to
    // start a tournament would be refused for a reason it never asked for.
    for (const name of options.drawn ?? []) {
      const event = this.eventNamed(name)
      const plan = planEventDraw(event)
      if (!plan.ok) {
        throw new Error(`cannot seed a draw for ${name}: ${plan.detail}`)
      }
      this.mutateEvent(event.id, (e) => ({ ...e, fixtures: plan.fixtures }))
    }
    // A tournament SEEDED live has been through go-live, so its ready fixtures are
    // `in_progress` matches already (#788) — a live seed whose fixtures stayed
    // matchless would be a world the server cannot produce (see
    // `materializeFixtures`).
    if (this.detail.status === 'live') {
      this.detail = {
        ...this.detail,
        events: this.detail.events.map(materializeFixtures),
      }
    }
    // The played-out result (ADR-0788), last: standings are derived from a decided draw, so
    // this rides on the seeded JOURNEY draw above rather than inventing one.
    if (options.standings ?? false) {
      const event = this.eventNamed(EVENT.JOURNEY)
      this.mutateEvent(event.id, (e) => ({ ...e, results: JOURNEY_RESULTS }))
    }
    // The two-stage result (ADR 20260727), on the same footing: it rides on the seeded
    // `EVENT.TWO_STAGE` draw rather than inventing one, and its group standings stand over
    // the groups that draw's snake actually dealt.
    if (options.twoStageResults) {
      const event = this.eventNamed(EVENT.TWO_STAGE)
      const results =
        options.twoStageResults === 'complete'
          ? CUP_RESULTS
          : CUP_RESULTS_MID_FLIGHT
      this.mutateEvent(event.id, (e) => ({ ...e, results }))
    }
    // A fixture standing on a table — what makes removing that table a 409 rather
    // than the quiet removal a merely reservation-held table gets.
    if (options.placed) {
      const event = this.eventNamed(options.placed)
      const fixture = event.fixtures[0]
      if (!fixture) {
        throw new Error(`cannot place a fixture for ${options.placed}: no draw`)
      }
      const table = this.detail.table_catalogue[0]
      this.mutateEvent(event.id, (e) => ({
        ...e,
        fixtures: e.fixtures.map((f) =>
          f.id === fixture.id
            ? {
                ...f,
                table_id: table.id,
                scheduled_start: simFixtureTime('2026-06-13T09:00:00'),
              }
            : f,
        ),
      }))
    }
    // The seeded solve ledger row, if any — a terminal strip state the spec starts on.
    if (options.latestSolve) {
      this.detail = { ...this.detail, latest_schedule_solve: options.latestSolve }
    }
  }

  /** The tournament's status as the *server* now holds it — for asserting the
   * walk really moved it, rather than that the badge changed. */
  get status(): TournamentStatus {
    return this.detail.status
  }

  private eventNamed(eventName: string): TournamentEventRead {
    const event = this.detail.events.find((e) => e.name === eventName)
    if (!event) throw new Error(`no such event in the seed: ${eventName}`)
    return event
  }

  /** The event as the *server* would report it: the `entered` count derived from
   * the live entrants, never stored (ADR-0016). A stub that carried its own
   * counter could drift from its own roster and hide exactly the bug the derived
   * count exists to prevent.
   *
   * `entry_state`'s **capacity** arm is re-derived here for exactly the same reason
   * (ADR-0783 §4): entering the last free place must make the event report itself
   * `event_full` on the very next read, and withdrawing must free it again. A tag
   * frozen at seed time would let a stub keep saying `open` while its roster was at
   * `max_players` — precisely the state the card is supposed to explain.
   *
   * A **stated** `rating_ineligible` survives untouched: it is a fact about the
   * caller's rating, not about the roster, and nothing on the wire can derive it. */
  private read(event: TournamentEventRead): TournamentEventRead {
    const entry_state =
      event.entry_state.state === 'rating_ineligible'
        ? event.entry_state
        : entryStateFor(event)
    return { ...event, entered: event.entrants.length, entry_state }
  }

  private readDetail(): TournamentDetailRead {
    return { ...this.detail, events: this.detail.events.map((e) => this.read(e)) }
  }

  /** One row of the LIST, which is the detail shape with the **draw-type catalogue
   * withheld** (`draw_type_catalogue: null`, `api/app/tournament_list.py`).
   *
   * A catalogue is page data for the one page that picks a draw type, so the list route
   * genuinely sends `null` rather than repeating global reference data on every row. It
   * is not `[]`: an empty array would say "the server can run no draw types at all",
   * which is a different — and false — claim, and a client that fell back to it would
   * render an empty picker instead of the one it is meant to. */
  private readListRow(): TournamentDetailRead {
    return { ...this.readDetail(), draw_type_catalogue: null }
  }

  /** The active entrants of an event, by event name — for assertions that want
   * the server's view rather than the DOM's. */
  entrantsOf(eventName: string): TournamentEntrantRead[] {
    return this.detail.events.find((e) => e.name === eventName)?.entrants ?? []
  }

  /** The fixtures of an event's draw, as the SERVER now holds them — so a spec can
   * assert the draw was really cut (and really thrown away), rather than that some
   * markup appeared and disappeared. Empty for an event with no draw. */
  fixturesOf(eventName: string): TournamentFixtureRead[] {
    return this.detail.events.find((e) => e.name === eventName)?.fixtures ?? []
  }

  /** An event's reservations as the server now holds them — for the other half of the
   * freeze: a reservation's *tables* really did change under a standing draw, and the
   * draw really did survive it. */
  reservationsOf(eventName: string): Reservation[] {
    return this.detail.events.find((e) => e.name === eventName)?.reservations ?? []
  }

  /**
   * Enter **me** into an event *behind this page's back* — the second tab of the
   * two-tab race (#943). No request is recorded, because none came from the page
   * under test: from its point of view the server simply moved on without it, and
   * whatever it is currently rendering is now stale.
   *
   * The next thing that page does with this event (clicking the Enter button it
   * still shows) is therefore a duplicate entry, which the server refuses with a
   * 409 — exactly as `enter()` below does.
   */
  enterElsewhere(eventName: string): TournamentEntrantRead {
    return this.addEntry(this.eventNamed(eventName).id)
  }

  /**
   * Move the tournament along its lifecycle *behind this page's back* — the
   * director's other tab, or their phone (#780). No request is recorded: nothing
   * the page under test did caused it, and from its point of view the world has
   * simply moved on without it.
   *
   * The button it is still showing therefore names an edge that no longer exists,
   * and clicking it is a request the server refuses with a **409** — the stale-view
   * case that `POST …/transitions` reconciles from.
   */
  transitionElsewhere(to: TournamentStatus) {
    this.detail = { ...this.detail, status: to }
  }

  /** Mint one active entry for ME on an event. A fresh entry id each time — as on
   * the server, where re-entry after a withdrawal INSERTs a new row rather than
   * resurrecting the tombstoned one. The withdraw address therefore changes, and
   * a client that cached the old entry id would 404 on the second withdrawal. */
  private addEntry(eventId: string): TournamentEntrantRead {
    this.entryCounter += 1
    const entrant = buildTournamentEntrantRead({
      id: `entry-me-${this.entryCounter}`,
      user_id: ME.userId,
      username: ME.username,
      // I am RATED — the same 1650 the ineligible event judged me on. So my own
      // chip is never the unrated one, and a spec asserting "the unrated mark is on
      // player.2" cannot pass by landing on me instead.
      rating: MY_RATING,
    })
    this.mutateEvent(eventId, (e) => ({ ...e, entrants: [...e.entrants, entrant] }))
    return entrant
  }

  countOf(method: string): number {
    return this.requests.filter((r) => r.method === method).length
  }

  /**
   * Refuse every event write with FastAPI's **422** until the returned callback is
   * invoked — the *unknown* refusal, which is the only kind left worth testing.
   *
   * The editor now mirrors every constraint the server actually has on an event
   * (`data/event-validation`), so no draft a spec can author through the UI reaches
   * the wire and comes back 422 — an over-long name is refused in the form now, which
   * is the whole point of #783's second QA pass and which took away this suite's only
   * way of *provoking* a server refusal. That must not quietly delete the assertion
   * underneath it: client validation only ever prevents the refusals we already know
   * about, and the editor's contract is that **the next unknown one does not eat
   * somebody's work** — and does not read Pydantic's prose out to them.
   *
   * So the refusal is forced rather than provoked, and it answers in FastAPI's own
   * body shape (a `detail` ARRAY of `{loc, msg}`): whatever the server's next
   * constraint turns out to be, that is the shape it will arrive in.
   */
  refuseEventWrites(): () => void {
    this.refusingWrites = true
    return () => {
      this.refusingWrites = false
    }
  }

  /**
   * The same forced 422, for `POST /v1/tournaments` — the "New tournament" dialog's
   * one write, and for the same reason: the dialog mirrors every constraint the
   * server has on what it sends (a name is `VARCHAR(255)` and `NOT NULL`), so the
   * only 422 left to test is the *unknown* one, and it cannot be provoked through
   * the form. It is the residual case the dialog exists to survive — and the case it
   * used to answer by printing Pydantic's sentence onto the name field.
   */
  refuseTournamentCreate(): () => void {
    this.refusingTournamentCreate = true
    return () => {
      this.refusingTournamentCreate = false
    }
  }

  /**
   * Answer every event write with a **500** — a fault of the SERVER's, not a refusal of
   * the request (#783 QA, round three).
   *
   * It is a separate switch from `refuseEventWrites` (the 422) because they are separate
   * *states*, and the editor got them wrong by treating them as one: a 5xx used to be
   * classified `unreachable` and read out as "the server couldn't be reached — check
   * your connection", which is false twice over (the server was reached; their
   * connection is fine) and sends an organizer to go and restart their router over our
   * crash. `DEFINITION_OF_COMPLETE.md` lists 5xx and network-down as distinct designed
   * states, so the suite has to be able to produce each of them.
   *
   * The body is FastAPI's real one for an unhandled exception — a plain `detail` string,
   * which is machinery, and which must therefore appear nowhere on screen either.
   */
  faultEventWrites(): () => void {
    this.faultingWrites = true
    return () => {
      this.faultingWrites = false
    }
  }

  /**
   * The same 500, for `POST /v1/tournaments` — the failure QA injected and got **nothing
   * at all** back from: no inline error, no toast, no alert. The dialog's 5xx branch was
   * never wired to the classifier, so the Create button went back to idle and the app
   * silently did not create a tournament.
   */
  faultTournamentCreate(): () => void {
    this.faultingTournamentCreate = true
    return () => {
      this.faultingTournamentCreate = false
    }
  }

  /**
   * Hold every *mutating* response open until the returned callback is invoked —
   * so a spec can look at the UI mid-flight (e.g. "Enter is disabled while the
   * entry is in the air", which is the double-submit guard). Reads keep flowing,
   * so the page still renders.
   */
  holdWrites(): () => void {
    let release!: () => void
    this.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    return () => {
      release()
      this.gate = null
    }
  }

  async install(page: Page) {
    // The client resolves its base URL to `${origin}/api`, so this one glob
    // catches everything the app asks for — session included. Anything NOT
    // routed here would be served `index.html` by the vite dev server and blow
    // up as a JSON parse error somewhere far from its cause.
    await page.route('**/api/v1/**', (route) => this.handle(route))
  }

  private session() {
    return sessionResponse({
      user: {
        username: ME.username,
        permissions: this.options.permissions ?? [
          PERM.TOURNAMENT_VIEW,
          PERM.TOURNAMENT_ENTER,
        ],
      },
    })
  }

  private async handle(route: Route) {
    const request = route.request()
    const method = request.method()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    this.requests.push({ method, path })

    if (path === '/v1/session') {
      return json(route, 200, this.session())
    }
    if (path === '/v1/notifications/unread-count') {
      return json(route, 200, UNREAD_COUNT)
    }
    // Same story as the bell above, one layer down: `_app` holds a realtime
    // stream open on every page. Parked rather than left to the 404 below, so
    // the client stands down instead of reconnect-looping and filling
    // `unhandled` (`../../support/realtime`).
    if (path === STREAM_PATH) {
      return fulfillParkedStream(route)
    }

    // The "Preview location" lookup. Mirrors the server: a resolvable address
    // gets coordinates plus a canonical label, an unresolvable one gets the coded
    // 409 (`address_not_geocodable`) the write path also answers with. An EMPTY
    // `address` is not modelled because the endpoint's `min_length` means it can
    // never legitimately be sent — the client short-circuits before the request,
    // and `requests` is what a spec asserts that on.
    if (method === 'GET' && path === '/v1/geocode') {
      const address = new URL(request.url()).searchParams.get('address') ?? ''
      if (address.includes(UNRESOLVABLE_ADDRESS)) {
        return json(route, 409, {
          detail: {
            code: 'address_not_geocodable',
            message: 'We couldn’t locate that address.',
          },
        })
      }
      return json(route, 200, {
        latitude: 37.8715,
        longitude: -122.273,
        formatted: address,
      })
    }

    // Writes wait on the gate (reads never do) — see `holdWrites`.
    if (method !== 'GET' && this.gate) await this.gate

    if (method === 'GET' && path === '/v1/tournaments') {
      return json(route, 200, [this.readListRow()])
    }
    if (method === 'GET' && path === `/v1/tournaments/${TOURNAMENT_ID}`) {
      // Walk any in-flight schedule solve one step per detail read — the read the
      // Schedule tab POLLS — so a spec watches the strip resolve queued → running →
      // succeeded at the client's own cadence, exactly as the worker would move it.
      this.tickSolve()
      return json(route, 200, this.readDetail())
    }

    // The schedule solver's one verb (ADR "the schedule is solved"). Matched before
    // the transitions/entries routes only for tidiness — its path collides with
    // nothing.
    if (
      method === 'POST' &&
      path === `/v1/tournaments/${TOURNAMENT_ID}/schedule/solves`
    ) {
      return this.requestSolve(route)
    }

    // The manual placement (ADR-0790) — while LIVE, a pin + a notification
    // (ADR "the schedule is solved; the call is pinned").
    const placement = path.match(
      /^\/v1\/tournaments\/([^/]+)\/fixtures\/([^/]+)\/placement$/,
    )
    if (method === 'PATCH' && placement) {
      return this.placeFixture(route, placement[2], request.postDataJSON())
    }

    // The list page's one write: `POST /v1/tournaments`, the "New tournament" dialog.
    if (method === 'POST' && path === '/v1/tournaments') {
      return this.createTournament(route, request.postDataJSON())
    }

    // The tournament-level PATCH — the Tables tab's write (ADR 20260801).
    if (method === 'PATCH' && path === `/v1/tournaments/${TOURNAMENT_ID}`) {
      return this.updateTournament(route, request.postDataJSON())
    }

    if (method === 'POST' && path === `/v1/tournaments/${TOURNAMENT_ID}/transitions`) {
      return this.transition(route, request.postDataJSON())
    }

    const enter = path.match(/^\/v1\/tournaments\/([^/]+)\/events\/([^/]+)\/entries$/)
    if (method === 'POST' && enter) {
      return this.enter(route, enter[2])
    }

    // The draw's two verbs (ADR-0786). Matched before the bare `:eventId` PATCH below —
    // as MSW registers them, and for the same reason: `…/events/{id}/draw` must never be
    // read as an event whose id is "draw".
    const draw = path.match(/^\/v1\/tournaments\/([^/]+)\/events\/([^/]+)\/draw$/)
    if (method === 'POST' && draw) {
      return this.cutDraw(route, draw[2])
    }
    if (method === 'DELETE' && draw) {
      return this.uncutDraw(route, draw[2])
    }

    // The event editor's two writes. They were unmocked until #783's QA pass, which
    // is not a coincidence: nothing in this suite had ever *saved* an event, so
    // nothing had ever watched the editor receive an answer — and the answer it was
    // getting (a 422) was being thrown away along with the organizer's work.
    if (method === 'POST' && path === `/v1/tournaments/${TOURNAMENT_ID}/events`) {
      return this.createEvent(route, request.postDataJSON())
    }
    const updateEvent = path.match(/^\/v1\/tournaments\/([^/]+)\/events\/([^/]+)$/)
    if (method === 'PATCH' && updateEvent) {
      return this.updateEvent(route, updateEvent[2], request.postDataJSON())
    }

    const withdraw = path.match(
      /^\/v1\/tournaments\/([^/]+)\/events\/([^/]+)\/entries\/([^/]+)$/,
    )
    if (method === 'DELETE' && withdraw) {
      return this.withdraw(route, withdraw[2], withdraw[3])
    }

    this.unhandled.push({ method, path })
    return json(route, 404, { detail: `unmocked ${method} ${path}` })
  }

  /**
   * `POST …/transitions` — the ONE way a status moves (ADR-0017). Mirrors the
   * server's refusals, in its order: 403 for a non-owner (`can_edit`), then 409 for an
   * edge that is not in the table — and then, for `published → live` alone, the **draw
   * precondition** (ADR-0786): a tournament starts only with at least one event and
   * every event's draw cut AND current.
   *
   * The 409's `detail` is the API's, verbatim, because it is what the user is shown —
   * the header renders the sentence inline, and for a refused start that sentence is a
   * WORK LIST (it names the events), so a stub that invented its own wording would test
   * the notice against a string the server never sends.
   */
  private async transition(route: Route, body: unknown) {
    const to = (body as { to?: TournamentStatus } | null)?.to
    if (!to) return json(route, 422, { detail: 'a transition needs a target' })

    if (!this.detail.can_edit) {
      return json(route, 403, {
        detail: 'You can only modify tournaments you created.',
      })
    }

    const from = this.detail.status
    if (!LEGAL_TRANSITIONS.some(([f, t]) => f === from && t === to)) {
      return json(route, 409, {
        // Both of the server's shapes. A self-transition (`from === to`) — the
        // stale tab, the commonest refusal there is — is told *what happened*
        // ("This tournament is already live."), not the tautology the two-ended
        // phrasing degenerates into there. Every other illegal edge names both
        // ends, since the target alone doesn't say why it was refused.
        detail:
          from === to
            ? `This tournament is already ${to}.`
            : `This tournament is ${from}; it cannot be moved to ${to}.`,
      })
    }

    // THE per-target precondition (ADR-0786), judged after the edge and only for `live`.
    // This stub used to have no such branch: `published → live` was accepted whatever
    // state the draws were in, so a Start button that could only ever 409 in production
    // sailed through every browser spec we had. Refused BEFORE the write, so a refused
    // start leaves the tournament exactly where it was — `published`, which is what the
    // header goes on rendering.
    if (to === 'live') {
      const refusal = goLiveRefusal(this.readDetail())
      if (refusal) return json(route, 409, { detail: refusal })
    }

    // Go-live materializes every event's ready fixtures into real `in_progress`
    // matches (#788) — only on `published → live`; publishing and archiving touch
    // no fixtures.
    const events =
      to === 'live' ? this.detail.events.map(materializeFixtures) : this.detail.events
    this.detail = { ...this.detail, events, status: to }
    // **201**, as the route is declared (`status_code=status.HTTP_201_CREATED` —
    // a transition CREATES a move, it does not update a field), and as the MSW
    // mock answers. A stub that answered 200 would be the one thing this table of
    // hand-written responses exists to prevent: a client agreeing with a server
    // that is not the one it will meet.
    return json(route, 201, this.readDetail())
  }

  /**
   * `POST …/events/{event_id}/draw` — cut (or re-cut) an event's draw.
   *
   * A re-cut replaces the draw **wholesale**: the old fixtures are dropped and a fresh
   * set is planned from the event's *current* entrants, so their ids do not survive
   * (which is what a spec asserts to tell a real re-cut from a no-op).
   *
   * Refused in the API's order — 404, 403, the play guard's 409, then the planner's 422
   * — and each refusal carries the server's own sentence, because for the 422 the
   * sentence IS the answer: it names the thing the director has to change.
   */
  private async cutDraw(route: Route, eventId: string) {
    const event = this.detail.events.find((e) => e.id === eventId)
    if (!event) return json(route, 404, { detail: 'event not found' })
    if (!this.detail.can_edit) {
      return json(route, 403, { detail: 'Only the creator can cut this draw.' })
    }
    // Asked BEFORE anything is planned or dropped, so a refused re-cut leaves the
    // standing draw exactly as it was.
    if (drawHasPlay(event)) {
      return json(route, 409, { detail: DRAW_UNDER_WAY_DETAIL })
    }
    const plan = planEventDraw(event)
    if (!plan.ok) return json(route, 422, { detail: plan.detail })

    const fixtures = plan.fixtures
    this.mutateEvent(eventId, (e) => ({ ...e, fixtures }))
    // **201** with the fixtures, as the route is declared — the client parses them
    // (`parseFixtures`, `data/api.ts`) before it reconciles off the refetch, so a body
    // of the wrong shape fails here rather than in production.
    return json(route, 201, fixtures)
  }

  // ----- the schedule solver (ADR "the schedule is solved; the call is pinned") ---

  private solveCounter = 0

  /** The solve ledger row as the SERVER now holds it — for asserting the strip
   * tracked the state rather than that some markup flickered. */
  get latestSolve(): ScheduleSolveRead | null {
    return this.detail.latest_schedule_solve
  }

  /**
   * `POST …/schedule/solves` — queue a run of the placement solver. Mirrors the
   * route's refusals in its order: 403 (not the owner — the strip must not offer
   * the button, so reaching this is a stale or forged view), then the **coded
   * 422** (`no_drawn_events`, the ADR-0968 `{code, message}` shape — a stub
   * answering bare prose would green a client that matched on the sentence).
   *
   * One solve in flight per tournament, as on the server: a POST while a run is
   * `queued`/`running` is absorbed and the SAME row answers — the double-click
   * spec asserts precisely that no second row is minted.
   */
  private async requestSolve(route: Route) {
    if (!this.detail.can_edit) {
      return json(route, 403, {
        detail: 'Only the creator can run the scheduler.',
      })
    }
    if (!this.detail.events.some((e) => e.fixtures.length > 0)) {
      return json(route, 422, {
        detail: {
          code: 'no_drawn_events',
          message: NO_DRAWN_EVENTS_MESSAGE,
        },
      })
    }
    const current = this.detail.latest_schedule_solve
    if (solveRowInFlight(current)) {
      return json(route, 202, current)
    }
    this.solveCounter += 1
    const solve = queuedSolveRow(`solve-${this.solveCounter}`)
    this.detail = { ...this.detail, latest_schedule_solve: solve }
    return json(route, 202, solve)
  }

  /** When the mock worker last advanced — the dwell below reads it. */
  private lastSolveTickAt = 0

  /** One step of the mock worker, driven by the detail READS (there is no real
   * queue here) — `stepScheduleSolve`, the shared sim (`solver-sim.ts`), so this
   * stub and the MSW store cannot drift apart on what a solve does: `queued` →
   * `running`, then `running` → `succeeded` with every unplaced grouped fixture
   * dealt onto its group's reservation tables (and, while LIVE, the imminent ones called).
   * Terminal rows never move — a seeded `infeasible`/`failed` strip stays what
   * the spec seeded.
   *
   * **At most one step per dwell** (`SOLVE_TICK_DWELL_MS`). The client's
   * reconcile can land two detail GETs back-to-back (the list key
   * prefix-matches the detail key, so one mutation's invalidate refetches it
   * twice), and a tick per read would walk queued → succeeded inside one
   * reconcile — the `solving` state would be unobservable, in the spec and in
   * front of a person. The dwell makes each step land on a DIFFERENT poll,
   * which is the loop under test. */
  private tickSolve() {
    const solve = this.detail.latest_schedule_solve
    if (!solve || !solveRowInFlight(solve)) return
    const now = Date.now()
    if (now - this.lastSolveTickAt < SOLVE_TICK_DWELL_MS) return
    this.lastSolveTickAt = now
    const step = stepScheduleSolve(
      solve,
      this.detail.events,
      this.detail.status === 'live',
    )
    if (!step) return
    this.detail = {
      ...this.detail,
      events: step.events,
      latest_schedule_solve: step.solve,
    }
  }

  /**
   * `PATCH …/fixtures/{fixture_id}/placement` — the director's hand, with the
   * SERVER's transition table (`apply_manual_placement`,
   * `api/app/match_calls.py`) via the shared `manualPlacementPin`
   * (`solver-sim.ts`, where the table is documented branch for branch) — one
   * implementation for this stub and the MSW store alike.
   *
   * Refused in the API's order: 403 (not the owner — the tab never offers the
   * control), 404 (no such fixture), 409 (the match is `completed`/`voided`, so
   * its placement is history), 422 (`table_id` names no table of THIS tournament
   * — `_enforce_table_exists`, `api/app/tournament_placement.py`, ADR 20260801,
   * the one invariant about an otherwise-soft placement). `null` is not a miss;
   * it is the unplace case, and always passes.
   */
  private async placeFixture(route: Route, fixtureId: string, body: unknown) {
    if (!this.detail.can_edit) {
      return json(route, 403, { detail: 'Only the creator can place matches.' })
    }
    const found = this.detail.events
      .flatMap((e) => e.fixtures)
      .find((f) => f.id === fixtureId)
    if (!found) return json(route, 404, { detail: 'fixture not found' })
    if (found.match_status === 'completed' || found.match_status === 'voided') {
      return json(route, 409, {
        detail: 'This match is finished, so its placement can no longer change.',
      })
    }

    const patch = body as {
      table_id?: string | null
      scheduled_start?: string | null
    } | null
    const table_id = patch?.table_id ?? null
    const scheduled_start = patch?.scheduled_start ?? null

    if (
      table_id !== null &&
      !this.detail.table_catalogue.some((table) => table.id === table_id)
    ) {
      return json(route, 422, {
        detail: [
          {
            type: 'value_error',
            loc: ['body', 'table_id'],
            msg: "This tournament's venue catalogue has no table with that id.",
            input: table_id,
          },
        ],
      })
    }

    const updated: TournamentFixtureRead = {
      ...found,
      table_id,
      // The wire ships the predicted start as a `FixtureTimeRead` (ADR "tournament
      // times are timezone-aware instants"); the PATCH body names a naive venue
      // wall-clock, so the stub composes the read shape the client parses.
      scheduled_start: scheduled_start === null ? null : simFixtureTime(scheduled_start),
      ...manualPlacementPin(
        this.detail.events,
        found,
        { table_id, scheduled_start },
        this.detail.status === 'live',
      ),
    }
    this.detail = {
      ...this.detail,
      events: this.detail.events.map((event) => ({
        ...event,
        fixtures: event.fixtures.map((f) => (f.id === fixtureId ? updated : f)),
      })),
    }
    return json(route, 200, updated)
  }

  /** `DELETE …/events/{event_id}/draw` — un-cut an event's draw. **Idempotent**: an
   * event with no draw is already in the state this asks for, so it is a 204, never a
   * 404. The one refusal is the cut's play guard — undoing a draw that has been played
   * would delete the fixtures those results belong to. */
  private async uncutDraw(route: Route, eventId: string) {
    const event = this.detail.events.find((e) => e.id === eventId)
    if (!event) return json(route, 404, { detail: 'event not found' })
    if (!this.detail.can_edit) {
      return json(route, 403, {
        detail: 'Only the creator can remove this draw.',
      })
    }
    if (drawHasPlay(event)) {
      return json(route, 409, { detail: DRAW_UNDER_WAY_DETAIL })
    }
    this.mutateEvent(eventId, (e) => ({ ...e, fixtures: [] }))
    return noContent(route)
  }


  /** `POST …/entries` — self-registration. No request body: the caller is always
   * the entrant. Mirrors the API's refusals so the spec cannot pass against a
   * stub more permissive than the server (400 non-singles, 409 window shut, 409
   * duplicate) — in the API's order: the permanent refusal first, then the
   * "not now" ones.
   *
   * ⚠️ **Every refusal is a CODED 409** (ADR-0968):
   * `{"detail": {"code": …, "message": …}}`. The client switches on the `code` and
   * owns the copy it shows; the `message` is what it falls back on for a code it
   * does not know. This suite runs with **MSW off** and nothing type-checks these
   * stub bodies — a stub still answering the pre-ADR `{"detail": "<sentence>"}`
   * would take the client's unknown-refusal path and the spec would fail on the
   * toast, which is the only place the mismatch could show. */
  private async enter(route: Route, eventId: string) {
    const event = this.detail.events.find((e) => e.id === eventId)
    if (!event) return json(route, 404, { detail: 'event not found' })
    if (event.format !== 'singles') {
      return json(route, 400, { detail: 'only singles events can be entered' })
    }
    const closed = this.registrationClosed()
    if (closed) {
      return json(route, 409, {
        detail: { code: 'registration_closed', message: closed },
      })
    }
    if (event.entrants.some((e) => e.user_id === ME.userId)) {
      // The server's partial unique index, in miniature: at most one *active*
      // entry per player per event. Asked BEFORE the event's own refusals below, so
      // an entrant in a full event is told "you are already in" — never "it's full".
      return json(route, 409, {
        detail: {
          code: 'already_entered',
          message: 'You have already entered this event.',
        },
      })
    }
    // The event's own refusals (#783), in the server's precedence — eligibility,
    // then capacity. The UI is supposed to render these as copy and offer no button
    // at all, so a spec should never reach them; they are here because a stub that
    // 201'd a full event would be more permissive than the server, and a regression
    // that kept offering Enter would then look perfect.
    const state = this.read(event).entry_state
    if (state.state === 'rating_ineligible') {
      return json(route, 409, {
        detail: {
          code: 'rating_ineligible',
          message: 'Your rating does not meet this event’s eligibility rules.',
        },
      })
    }
    if (state.state === 'event_full') {
      return json(route, 409, {
        detail: { code: 'event_full', message: 'This event is full.' },
      })
    }

    return json(route, 201, this.addEntry(eventId))
  }

  /**
   * `POST /v1/tournaments` — the "New tournament" dialog's write. Refused with the
   * same FastAPI 422 (a `detail` ARRAY, `loc: ["body", "name"]`) while
   * `refuseTournamentCreate()` is in force; otherwise a 201 whose id is the one the
   * store serves a detail page for, so the dialog's success navigation lands
   * somewhere real.
   */
  private async createTournament(route: Route, body: unknown) {
    // Recorded BEFORE the refusal branches: what the client sent is a fact
    // whether or not this stub chose to accept it.
    this.createBodies.push(body as TournamentCreate)
    if (this.faultingTournamentCreate) return serverFault(route)
    if (this.refusingTournamentCreate) return this.unprocessableName(route)

    const fields = body as { name?: string }
    this.detail = { ...this.detail, name: fields.name ?? this.detail.name }
    return json(route, 201, this.readDetail())
  }

  /**
   * `PATCH /v1/tournaments/{id}` — the tournament's own fields, and the one this
   * suite exists for: the **table catalogue as an id-keyed diff** (ADR 20260801).
   *
   * The three cases are exhaustive and mean different things, so the stub implements
   * all three rather than the one the happy path needs:
   *
   * - an entry **citing an id** keeps that table, with this payload's words and place;
   * - an entry with **no id** is an insert, and the id is **minted here** — the client
   *   has none to give, and one it invented would name no table of this tournament;
   * - a stored table **no entry cites** is REMOVED.
   *
   * And the removal's refusal, judged **before anything is written**: a table matches
   * are *placed at* cannot go without `unplace_fixtures_on_removed_tables: true`, and
   * without it the answer is a 409 carrying the server's own sentence — verbatim,
   * because the confirm dialog renders it verbatim. (A table only a *reservation* holds
   * needs no opt-in: a reservation is not a placement.)
   *
   * The 422 arm matters as much as the 409: it is what makes a client-minted id a
   * loud failure here, exactly as it is on the server. A stub that quietly minted an
   * id for an entry citing an unknown one would let the very regression this chore
   * fixed sail through green.
   */
  private async updateTournament(route: Route, body: unknown) {
    this.patchBodies.push(body as TournamentUpdate)
    if (this.faultingWrites) return serverFault(route)
    if (!this.detail.can_edit) {
      return json(route, 403, {
        detail: 'Only the creator can edit this tournament.',
      })
    }

    const patch = body as TournamentUpdate
    const submitted = patch.table_catalogue
    if (submitted === undefined || submitted === null) {
      this.detail = { ...this.detail, name: patch.name ?? this.detail.name }
      return json(route, 200, this.readDetail())
    }

    const stored = this.detail.table_catalogue
    const byId = new Map(stored.map((t) => [t.id, t]))
    for (const [index, entry] of submitted.entries()) {
      if (entry.id != null && !byId.has(entry.id)) {
        return json(route, 422, {
          detail: [
            {
              type: 'value_error',
              loc: ['body', 'table_catalogue', index, 'id'],
              msg: "This tournament's venue catalogue has no table with that id.",
              input: entry.id,
            },
          ],
        })
      }
    }

    const kept = new Set(
      submitted.map((e) => e.id).filter((id): id is string => id != null),
    )
    const removed = stored.filter((t) => !kept.has(t.id))
    const removedIds = new Set(removed.map((t) => t.id))
    const placed = this.detail.events
      .flatMap((e) => e.fixtures)
      .filter((f) => f.table_id !== null && removedIds.has(f.table_id))

    // The opt-in has ONE affirmative spelling; omitted, `false` and `null` are three
    // ways of not saying it, and all three refuse.
    if (placed.length > 0 && patch.unplace_fixtures_on_removed_tables !== true) {
      const blocking = new Set(placed.map((f) => f.table_id))
      const labels = removed.filter((t) => blocking.has(t.id)).map((t) => t.label)
      return json(route, 409, {
        detail: tablesInUseDetail(labels, placed.length),
      })
    }

    const unplaced = new Set(placed.map((f) => f.id))
    this.detail = {
      ...this.detail,
      name: patch.name ?? this.detail.name,
      // The list's ORDER is the catalogue's order; a cited row keeps its id while
      // taking this payload's words and place.
      table_catalogue: submitted.map((entry) => this.upsertTable(entry)),
      events: this.detail.events.map((event) => ({
        ...event,
        fixtures: event.fixtures.map((f) =>
          unplaced.has(f.id)
            ? { ...f, table_id: null, scheduled_start: null, pinned_at: null }
            : f,
        ),
      })),
    }
    return json(route, 200, this.readDetail())
  }

  /** One catalogue entry after the diff: the cited row, re-worded — or a brand-new
   * one whose **uuid the server mints** (`gen_random_uuid()`; `TournamentTable.id` is
   * `format: uuid` on the wire, so the stub must not hand back a slug). */
  private upsertTable(entry: TournamentTableUpsert): TournamentTable {
    if (entry.id != null) {
      return { id: entry.id, label: entry.label, court: entry.court }
    }
    this.tableCounter += 1
    return {
      id: mockUuid(`e2e-tournament-table-${this.tableCounter}`),
      label: entry.label,
      court: entry.court,
    }
  }

  /** One reservation of an event write after the diff: the cited reservation, re-worded
   * and re-positioned — or a brand-new one whose **uuid the server mints**
   * (`gen_random_uuid()`; `Reservation.id` is `format: uuid` on the wire, so the stub
   * must not hand back a slug, and a client cannot author one at all: ADR 20260801).
   *
   * The twin of `upsertTable` above, one resource over. On the create path the `id` arm
   * is unreachable by construction — `ReservationWrite` has no id — which is exactly the
   * point: a created event's reservations are all new, and all minted here. */
  private upsertReservation(
    entry: ReservationUpsert,
    position: number,
  ): Reservation {
    const id =
      entry.id ??
      mockUuid(`e2e-tournament-event-reservation-${(this.reservationCounter += 1)}`)
    return {
      id,
      name: entry.name,
      slot: entry.slot,
      table_ids: entry.table_ids,
      position,
    }
  }

  /** The catalogue as the SERVER now holds it — so a spec asserts what was stored
   * (and which id it was stored under), not what the DOM happens to show. */
  get tables(): TournamentTable[] {
    return this.detail.table_catalogue
  }

  /**
   * `POST …/events` — create an event, and **refuse an over-long name with a 422**,
   * as the server does (`VARCHAR(255)`), in FastAPI's own body shape: a `detail`
   * ARRAY of `{msg}` objects, which `extractDetail` (`src/api/client.ts`) is what
   * turns into the sentence the editor shows. A stub that answered `{detail: "…"}`
   * would be testing the client against a server it will never meet.
   *
   * Everything else is a 201. Notably a rule with a **null value** is one of them:
   * the API deliberately still accepts a half-written rule (it constrains nobody),
   * which is exactly why the guard against `Rating < ?` has to live in the client.
   * A stub that 422'd it would let a spec pass against a server stricter than the
   * real one — and would prove nothing about the form.
   */
  private async createEvent(route: Route, body: unknown) {
    if (this.faultingWrites) return serverFault(route)
    if (this.refusingWrites || nameTooLong(body)) return this.unprocessableName(route)

    // The wire body (`TournamentEventCreate`) is the read shape minus the fields the
    // server owns — `entered` is derived, and a new event has no entrants.
    const { reservations: submitted, ...fields } = body as Partial<
      Omit<TournamentEventRead, 'entered' | 'reservations'>
    > & { reservations?: ReservationUpsert[] }
    const created = buildTournamentEventRead({
      ...fields,
      // Every reservation of a created event is a NEW reservation: `ReservationWrite`
      // has no `id` at all (ADR 20260801), so the server mints one for each and assigns
      // the position from the array index — the body carries neither, and the order of
      // the list is what says which reservation is first. See the same pair in
      // `updateEvent` below. `groups` is left unstated here — `buildTournamentEventRead`
      // mints it 1:1 from the reservations this override supplies.
      ...(submitted
        ? {
            reservations: submitted.map((reservation, index) =>
              this.upsertReservation(reservation, index),
            ),
          }
        : {}),
      id: `ev-created-${this.detail.events.length + 1}`,
      entrants: [],
    })
    this.detail = { ...this.detail, events: [...this.detail.events, created] }
    return json(route, 201, this.read(created))
  }

  /** `PATCH …/events/{event_id}` — edit an event, with the same 422, and with the two
   * **freezes** a cut draw puts on it (ADR-0786, a 409 each): the event's set of groups
   * and its draw type.
   *
   * The editor declines to *build* either change while a draw stands (the controls are
   * disabled, with the reason), so a spec should never reach these — they are here
   * because a stub that answered **200** to a group-set change would be more permissive
   * than the server, and the day the freeze regressed, the editor would silently orphan
   * every fixture in `npm run dev` and in this suite, and 409 only in production.
   *
   * ⚠️ It is the CHANGE that is refused, never the mere presence of the key: the editor
   * PATCHes the whole form back — `reservations` and `draw_type` included — to move a
   * reservation's tables, which is exactly the edit the freeze exists to permit (a table
   * breaks mid-event and has to be recorded without destroying a correct draw). A stub
   * that fired on the key would fail the "tables stay editable" spec, and would be
   * wrong. */
  private async updateEvent(route: Route, eventId: string, body: unknown) {
    const event = this.detail.events.find((e) => e.id === eventId)
    if (!event) return json(route, 404, { detail: 'event not found' })
    if (this.faultingWrites) return serverFault(route)
    if (this.refusingWrites || nameTooLong(body)) return this.unprocessableName(route)

    const frozen = frozenDetail(event, body)
    if (frozen) return json(route, 409, { detail: frozen })

    const fields = body as Partial<
      Omit<TournamentEventRead, 'entered' | 'reservations' | 'groups'>
    > & {
      reservations?: ReservationUpsert[]
    }
    // `entrants` and `entered` are the server's, not the editor's — the write body
    // does not carry them, and echoing the client's view back would clobber
    // registrations it never saw.
    //
    // A reservation's `id` and its `position` are the server's too, and in a sharper
    // way: both write shapes FORBID `position` and the create shape has no `id` at all,
    // so the body carries neither and the **order of the array** is the only thing
    // saying which reservation is first. So this stub applies the reservations as the
    // server does — an entry citing an id keeps that reservation (and its mapped
    // group), an entry with none is minted a fresh uuid and a fresh group
    // (`upsertReservation`, `groupsFor`), and every one of them takes the position of
    // its index. Spreading the write shape straight through would strip two required
    // read fields and leave the editor (which seeds its cards from `position`) sorting
    // by nothing.
    this.mutateEvent(eventId, (e) => {
      const reservations = fields.reservations
        ? fields.reservations.map((reservation, index) =>
            this.upsertReservation(reservation, index),
          )
        : e.reservations
      return {
        ...e,
        ...fields,
        reservations,
        // **Minted 1:1 with the (possibly new) reservations** (ticket #1369) — never
        // stored independently, so the mapping cannot drift out of step with a write
        // that changed the reservation set.
        groups: groupsFor(reservations),
        entrants: e.entrants,
        // **Re-minted on a draw-type change, in place** (ADR 20260815 decision 3) — the
        // same rule `mocks/tournaments-store.ts`'s `updateEvent` follows, and reachable
        // for the same reason: `frozenDetail` above already 409s a draw-type change while
        // a draw stands, so this can only run against an undrawn event.
        stages:
          fields.draw_type == null ? e.stages : mintStageReads(fields.draw_type),
      }
    })
    return json(route, 200, this.read(this.eventNamed(fields.name ?? event.name)))
  }

  /** FastAPI's 422, verbatim: `detail` is an ARRAY of pydantic errors. A stub
   * answering `{detail: "…"}` here would be testing the client against a server it
   * will never meet — and would hide the very thing round two was about, because a
   * plain-string detail is *our* copy and may legitimately be shown, while this `msg`
   * is **Pydantic's** and may not. The client reads the `loc` (which field) and words
   * the rest itself (`data/save-failure`); this `msg` must appear NOWHERE on screen.
   *
   * Shared by the event writes and `POST /v1/tournaments`, because it is the same
   * refusal: both names are `VARCHAR(255)`, and FastAPI words them identically. */
  private unprocessableName(route: Route) {
    return json(route, 422, {
      detail: [
        {
          type: 'string_too_long',
          loc: ['body', 'name'],
          msg: `String should have at most ${EVENT_NAME_MAX} characters`,
        },
      ],
    })
  }

  /** `DELETE …/entries/{entry_id}` — withdrawal. The server soft-deletes; from
   * the wire that is indistinguishable from dropping the row, since a withdrawn
   * entry appears in neither the roster nor the count. Withdrawing an entry
   * that is already gone is idempotent (204), exactly as on the server. */
  private async withdraw(route: Route, eventId: string, entryId: string) {
    const event = this.detail.events.find((e) => e.id === eventId)
    if (!event) return json(route, 404, { detail: 'event not found' })

    const entrant = event.entrants.find((e) => e.id === entryId)
    // Idempotent in EVERY status, gate or no gate (ADR-0017): an entry that is
    // already withdrawn has nothing left to lock, so this stays a 204 rather than
    // becoming the 409 a blunt gate would make it.
    if (!entrant) return noContent(route)
    if (entrant.user_id !== ME.userId) {
      return json(route, 403, { detail: 'not your entry' })
    }
    // …but withdrawing a LIVE entry is refused once the window shuts: pulling a
    // player out from under a draw cut from the field they were in is precisely
    // what going live forbids.
    const closed = this.registrationClosed()
    if (closed) return json(route, 409, { detail: closed })

    this.mutateEvent(eventId, (e) => ({
      ...e,
      entrants: e.entrants.filter((x) => x.id !== entryId),
    }))
    return noContent(route)
  }

  /** The server's SENTENCE for why a *state change* to an entry is refused right
   * now, or `null` while the window is open. Only `published` is open — the status
   * IS the state of the registration window (ADR-0017).
   *
   * Entering wraps this in the `registration_closed` CODE (ADR-0968); withdrawing
   * still sends it bare, because the withdraw route's 409 is still prose. */
  private registrationClosed(): string | null {
    const status = this.detail.status
    return status === 'published' ? null : REGISTRATION_CLOSED_DETAIL[status]
  }

  private mutateEvent(
    eventId: string,
    fn: (event: TournamentEventRead) => TournamentEventRead,
  ) {
    this.detail = {
      ...this.detail,
      events: this.detail.events.map((e) => (e.id === eventId ? fn(e) : e)),
    }
  }
}

/** The one server-side constraint on an event write this suite mirrors: the name
 * column's length. Everything else the editor can author, the API accepts — a rule
 * with no value included, which is exactly why the client has to refuse it. */
function nameTooLong(body: unknown): boolean {
  const name = (body as { name?: unknown } | null)?.name
  return typeof name === 'string' && name.length > EVENT_NAME_MAX
}

/** FastAPI's 500 for an unhandled exception, verbatim: a plain-string `detail`. Which
 * is the trap — a plain-string `detail` is normally *our* copy and may be shown, so a
 * classifier reading the body instead of the STATUS would print "Internal Server Error"
 * to an organizer. It must appear nowhere on screen; what the user is told is the
 * client's own sentence, and it is not about their connection. */
function serverFault(route: Route) {
  return json(route, 500, { detail: 'Internal Server Error' })
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function noContent(route: Route) {
  return route.fulfill({ status: 204 })
}
