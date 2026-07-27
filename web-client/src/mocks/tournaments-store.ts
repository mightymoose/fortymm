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
  DRAW_TYPE_CATALOGUE,
  entryStateFor,
  planRoundRobinFixtures,
  planSingleElimFixtures,
} from '@/mocks/factories/tournaments/tournament.factory'
import {
  manualPlacementPin,
  NO_DRAWN_EVENTS_MESSAGE,
  queuedSolveRow,
  simFixtureTime,
  SOLVE_TICK_DWELL_MS,
  solveRowInFlight,
  stepScheduleSolve,
} from '@/mocks/factories/tournaments/solver-sim'
import { mockUuid } from '@/mocks/mock-uuid'
import { conjoinWithAnd, hasVenue } from '@/components/tournaments/data/helpers'
import type { TournamentsNearMe } from '@/components/tournaments/data/api'

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
type TournamentTable = components['schemas']['TournamentTable']
type TournamentEntrantRead = components['schemas']['TournamentEntrantRead']
type Pool = components['schemas']['Pool']
type ScheduleSolveRead = components['schemas']['ScheduleSolveRead']

/** What the store actually holds for an event: everything the wire shape has
 * *except* the two fields the server DERIVES at read time — the `entered` count
 * and the caller-aware `entry_state`. Deriving them on read (rather than storing
 * them) makes "the counter says 52, the list has 51" — and its twin, "the event
 * says `open` while holding all 64 of its 64 entrants" — unrepresentable. It is
 * the same reason the API has no `entered` column.
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
 * thrown their draw away. */
type StoredEvent = Omit<TournamentEventRead, 'entered' | 'entry_state'> & {
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

/** The two pools the seed's ONE drawn event is cut across (`ev-u1200` below). Pulled
 * out of the seed so the fixtures it is seeded with can be planned across the very same
 * pool ids: a fixture's `pool_id` is a string ref into its event's own `pools`
 * (ADR-0786 — not a foreign key, because pools are JSONB value-objects), so a seed that
 * spelled the ids twice could spell them differently, and every fixture would point at
 * a pool that does not exist. */
const U1200_POOLS: Pool[] = [
  {
    id: 'p-u1200-a',
    name: 'Pool A',
    slot: { date: '2026-06-14', start: '09:00', end: '10:30' },
    table_ids: ['t1', 't2'],
  },
  {
    id: 'p-u1200-b',
    name: 'Pool B',
    slot: { date: '2026-06-14', start: '10:30', end: '12:00' },
    table_ids: ['t3', 't4'],
  },
]

/** The pools of Summer Slam's one event — the seed's **ready-to-start** tournament (see
 * below). Pulled out for the same reason `U1200_POOLS` is: the fixtures are planned
 * against these very ids, so they cannot be spelled twice and spelled differently. */
const SLAM_POOLS: Pool[] = [
  {
    id: 'p-slam-a',
    name: 'Pool A',
    slot: { date: '2026-08-22', start: '09:00', end: '11:00' },
    table_ids: ['t1', 't2'],
  },
  {
    id: 'p-slam-b',
    name: 'Pool B',
    slot: { date: '2026-08-22', start: '11:00', end: '13:00' },
    table_ids: ['t3', 't4'],
  },
]

function seed(): StoredTournament[] {
  return [
    {
      id: 'bay-area-open-2026',
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
          tournament_id: 'bay-area-open-2026',
          name: 'Open Singles',
          format: 'singles',
          draw_type: 'round-robin',
          max_players: 64,
          entry_fee: 45,
          timezone: 'America/Chicago',
          entrants: otherEntrants('ev-open-singles', 52),
          slot: { date: '2026-06-13', start: '09:00', end: '18:00' },
          match_settings: { rated: true, length_games: 5 },
          predicates: [],
          pools: [
            {
              id: 'p-os-1',
              name: 'Pool A',
              slot: { date: '2026-06-13', start: '09:00', end: '12:30' },
              table_ids: ['t1', 't2', 't3', 't4'],
            },
            {
              id: 'p-os-2',
              name: 'Pool B',
              slot: { date: '2026-06-13', start: '13:30', end: '17:00' },
              table_ids: ['t1', 't2', 't3', 't4', 't5', 't6'],
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
          // It is ALSO the seed's **uncuttable** event, and it stays uncuttable for a
          // reason that survives (ADR 20260726): round-robin with **NO POOLS**. It used
          // to be `rr-then-ko`, refused because nothing could plan that type — but that
          // slug left the enum, and "an unplannable type" is no longer a state a valid
          // event can be in. `pools: []` is the refusal that replaces it, and it is
          // permanent: "A round-robin draw needs at least one pool." Do not give it pools.
          id: 'ev-u1500',
          tournament_id: 'bay-area-open-2026',
          name: 'U1500 Singles',
          format: 'singles',
          draw_type: 'round-robin',
          max_players: 48,
          entry_fee: 30,
          timezone: 'America/Los_Angeles',
          entrants: [],
          slot: { date: '2026-06-14', start: '09:00', end: '16:00' },
          match_settings: { rated: true, length_games: 3 },
          predicates: [{ id: 'pr-2', field: 'rating', op: '<', value: 1500 }],
          pools: [],
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
          tournament_id: 'bay-area-open-2026',
          name: 'Championship Singles',
          format: 'singles',
          draw_type: 'single-elim',
          max_players: 16,
          entry_fee: 60,
          timezone: 'America/Los_Angeles',
          entrants: otherEntrants('ev-champ-singles', 16),
          slot: { date: '2026-06-14', start: '13:00', end: '18:00' },
          match_settings: { rated: true, length_games: 7 },
          predicates: [],
          pools: [],
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
          // It is ALSO the seed's one **drawn** event (ADR-0786) — the only one that
          // arrives with fixtures already, so `npm run dev` can show a cut draw without
          // anyone clicking Generate. Round-robin, because a POOLED draw is the one whose
          // scaffold (pools, rounds, the sit-out) needs seeing without anybody clicking;
          // the bracket is one Generate click away on any single-elim event, both types
          // being cuttable here now. Nine entrants across two pools
          // (5 + 4 by the snake) — an ODD pool, so Pool A's rounds have a player
          // sitting out, and a bye is visible for what it is: the ABSENCE of a fixture,
          // not a fixture with an empty side.
          id: 'ev-u1200',
          tournament_id: 'bay-area-open-2026',
          name: 'U1200 Singles',
          format: 'singles',
          draw_type: 'round-robin',
          max_players: 24,
          entry_fee: 20,
          timezone: 'America/Los_Angeles',
          entrants: otherEntrants('ev-u1200', 9),
          slot: { date: '2026-06-14', start: '09:00', end: '12:00' },
          match_settings: { rated: true, length_games: 3 },
          predicates: [{ id: 'pr-u1200', field: 'rating', op: '<', value: 1200 }],
          ineligible: { predicate_id: 'pr-u1200', rating: DEV_USER_RATING },
          pools: U1200_POOLS,
          // Planned by the same function the store's `cutDraw` uses, from the same
          // entrants and the same pools — so the seeded draw is one this store could
          // have cut, rather than a hand-written list that no cut would ever produce.
          fixtures: planRoundRobinFixtures(
            otherEntrants('ev-u1200', 9).map((e) => e.id),
            U1200_POOLS.map((p) => p.id),
          ),
          // Representative RESULTS (ADR-0788) so `npm run dev` shows standings live: Pool
          // A still being played (`complete: false` — the table fills in as matches land),
          // Pool B decided. Multi-pool, so there is no single champion without a knockout
          // stage (a later slice) — `champion: null` even where a pool is done. The entry
          // ids match this event's entrants (`entry-ev-u1200-N`) and its pool ids
          // (`p-u1200-a/b`), so the name and pool joins land; the rows are in finishing
          // order, which the client renders untouched.
          results: {
            kind: 'standings',
            complete: false,
            champion: null,
            pools: [
              {
                pool_id: 'p-u1200-a',
                complete: false,
                rows: [
                  { entry_id: 'entry-ev-u1200-1', rank: 1, played: 2, wins: 2, losses: 0, games_won: 4, games_lost: 1, game_difference: 3 },
                  { entry_id: 'entry-ev-u1200-5', rank: 2, played: 1, wins: 1, losses: 0, games_won: 2, games_lost: 0, game_difference: 2 },
                  { entry_id: 'entry-ev-u1200-4', rank: 3, played: 2, wins: 1, losses: 1, games_won: 3, games_lost: 3, game_difference: 0 },
                  { entry_id: 'entry-ev-u1200-8', rank: 4, played: 1, wins: 0, losses: 1, games_won: 1, games_lost: 2, game_difference: -1 },
                  { entry_id: 'entry-ev-u1200-9', rank: 5, played: 2, wins: 0, losses: 2, games_won: 1, games_lost: 4, game_difference: -3 },
                ],
              },
              {
                pool_id: 'p-u1200-b',
                complete: true,
                rows: [
                  { entry_id: 'entry-ev-u1200-2', rank: 1, played: 3, wins: 3, losses: 0, games_won: 6, games_lost: 2, game_difference: 4 },
                  { entry_id: 'entry-ev-u1200-3', rank: 2, played: 3, wins: 2, losses: 1, games_won: 5, games_lost: 4, game_difference: 1 },
                  { entry_id: 'entry-ev-u1200-6', rank: 3, played: 3, wins: 1, losses: 2, games_won: 4, games_lost: 5, game_difference: -1 },
                  { entry_id: 'entry-ev-u1200-7', rank: 4, played: 3, wins: 0, losses: 3, games_won: 2, games_lost: 6, game_difference: -4 },
                ],
              },
            ],
          },
          created_at: '2026-06-01T09:06:45Z',
          updated_at: '2026-06-09T12:00:00Z',
        },
        {
          // A doubles event: entry is a singles-only affair (one row per user
          // cannot express a pairing — ADR-0016), so the API 400s here and the
          // UI offers no Enter control. Seeded so that case is visible in dev.
          id: 'ev-mixed-doubles',
          tournament_id: 'bay-area-open-2026',
          name: 'Mixed Doubles',
          format: 'doubles',
          draw_type: 'single-elim',
          max_players: 32,
          entry_fee: 25,
          timezone: 'America/Los_Angeles',
          entrants: [],
          slot: { date: '2026-06-14', start: '10:00', end: '15:00' },
          match_settings: { rated: false, length_games: 3 },
          predicates: [],
          pools: [],
          fixtures: [],
          results: null,
          created_at: '2026-06-01T09:07:00Z',
          updated_at: '2026-06-09T12:00:00Z',
        },
      ],
    },
    {
      id: 'summer-slam-2026',
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
          // Round-robin with pools and a draw cut from its own entrants, so it is
          // `current` by the same set-comparison the server makes. Publish this
          // tournament and Start works; publish the Bay Area Open — four of whose five
          // events have no draw — and Start is refused, by name. The seed holds both.
          id: 'ev-slam-open',
          tournament_id: 'summer-slam-2026',
          name: 'Slam Open Singles',
          format: 'singles',
          draw_type: 'round-robin',
          max_players: 16,
          entry_fee: 20,
          timezone: 'America/New_York',
          entrants: otherEntrants('ev-slam-open', 8),
          slot: { date: '2026-08-22', start: '09:00', end: '13:00' },
          match_settings: { rated: true, length_games: 5 },
          predicates: [],
          pools: SLAM_POOLS,
          fixtures: planRoundRobinFixtures(
            otherEntrants('ev-slam-open', 8).map((e) => e.id),
            SLAM_POOLS.map((p) => p.id),
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
      id: 'club-champs-2026',
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
          tournament_id: 'club-champs-2026',
          name: "Women's Championship Singles",
          format: 'singles',
          draw_type: 'single-elim',
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
          // Two group-stage pools on disjoint tables, then a knockout that
          // reuses the show tables once the groups are done. No pair both
          // overlaps in time and shares a table, so this seed raises no
          // double-booking diagnostic (see `findPoolConflicts`).
          pools: [
            {
              id: 'p-cc-1',
              name: 'Group A',
              slot: { date: '2026-07-01', start: '17:00', end: '19:00' },
              table_ids: ['t1', 't2', 't3'],
            },
            {
              id: 'p-cc-2',
              name: 'Group B',
              slot: { date: '2026-07-01', start: '17:00', end: '19:00' },
              table_ids: ['t4', 't5', 't6'],
            },
            {
              id: 'p-cc-3',
              name: 'Knockout',
              slot: { date: '2026-07-01', start: '19:15', end: '21:00' },
              table_ids: ['t1', 't2'],
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
      id: 'garage-invitational-2026',
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
          tournament_id: 'garage-invitational-2026',
          name: 'Garage Singles',
          format: 'singles',
          draw_type: 'round-robin',
          max_players: 8,
          entry_fee: 0,
          timezone: 'America/Los_Angeles',
          entrants: otherEntrants('ev-garage-open', 3),
          slot: { date: '2026-09-12', start: '13:00', end: '17:00' },
          match_settings: { rated: false, length_games: 3 },
          predicates: [],
          pools: [],
          fixtures: [],
          results: null,
          created_at: '2026-06-13T18:01:00Z',
          updated_at: '2026-06-13T18:01:00Z',
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
      id: 'league-office-draft-2027',
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
 * the entrants — the one place the count comes from — and the caller-aware
 * `entry_state` from the entrants and the seeded rating verdict. */
function readEvent(event: StoredEvent): TournamentEventRead {
  const { ineligible, ...wire } = event
  void ineligible
  return { ...wire, entered: event.entrants.length, entry_state: entryState(event) }
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

function slugId(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'tournament'
  createCounter += 1
  return `${base}-${createCounter}`
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

export function createTournament(body: TournamentCreate): TournamentRead {
  const now = new Date().toISOString()
  const id = slugId(body.name)
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
    table_catalogue: body.table_catalogue ?? [],
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

export type StoreResult =
  | { ok: true; tournament: TournamentRead }
  | { ok: false; status: 403 | 404 }

/** An event write fails four ways: 404 (no such tournament/event), 403 (not the
 * creator), and — on a PATCH that would move the pools out from under a cut draw — a
 * **409** carrying the server's sentence (ADR-0786's pool-set freeze; see
 * `poolSetFrozenDetail`). A create can never hit that 409: a new event has no draw. */
export type EventResult =
  | { ok: true; event: TournamentEventRead }
  | { ok: false; status: 403 | 404 }
  | { ok: false; status: 409; detail: string }

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
 * (ADR-0017), so an edit cannot move the lifecycle — only a transition can. */
export function updateTournament(
  id: string,
  patch: TournamentUpdate,
): StoreResult {
  const owned = requireOwned(id)
  if (!owned.ok) return owned
  const existing = owned.tournament
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
    table_catalogue:
      patch.table_catalogue === undefined || patch.table_catalogue === null
        ? existing.table_catalogue
        : patch.table_catalogue,
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

/** The things a refusal is about, as a human would say them: `“Pool B”`, or
 * `“Pool B” and “Pool C”` (`named_list`, `api/app/schemas/tournament.py`). */
function namedList(names: string[]): string {
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

/** Why this tournament cannot start yet, in the server's own words — or `null` when it
 * can. **It names the events**, because a refusal a director cannot act on is barely
 * better than a 500: "some event has no draw" leaves them clicking through a ten-event
 * tournament looking for it.
 *
 * The two failures are kept apart in the sentence, because they are two different jobs:
 * an **uncut** event needs a first cut, while a **stale** one has a draw the director may
 * well have reviewed and approved — it is merely older than the field — and needs
 * re-cutting. */
function goLiveRefusal(tournament: StoredTournament): string | null {
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
  // (#788) — the same act that makes each pool pairing playable and gives the draw panel
  // its "View match" links. Only on `published → live`; publishing and archiving touch no
  // fixtures.
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

let eventCounter = 0

/** Create an event on a tournament. Creator-only (403 on a non-owned row). */
export function createEvent(
  tournamentId: string,
  body: TournamentEventCreate,
): EventResult {
  const owned = requireOwned(tournamentId)
  if (!owned.ok) return owned
  const existing = owned.tournament
  eventCounter += 1
  const now = new Date().toISOString()
  const event: StoredEvent = {
    id: `ev-new-${eventCounter}`,
    tournament_id: tournamentId,
    name: body.name,
    format: body.format,
    draw_type: body.draw_type,
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
    pools: body.pools ?? [],
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
 * **The pool SET freezes while a draw exists** (ADR-0786): a `pools` payload that would
 * add, remove or re-`id` a pool on an event whose draw is cut is refused with a 409,
 * because a fixture's `pool_id` is a string ref into this very JSONB and nothing in the
 * database stops the edit from orphaning it. Everything ELSE about a pool — its tables,
 * its window, its name — stays editable with a draw standing, because venues change
 * under running tournaments and recording that must not cost a director their draw.
 *
 * The mock enforces it because a mock that is more permissive than the server it stands
 * in for is a trap: a pools editor that silently orphans a draw would look perfect in
 * `npm run dev` and 409 in production. */
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
  // reason a stranger's request is refused. (The 422s come before all of it — they are
  // the schema's, and the handler asks them at the boundary; see `validateEventBody`.)
  const frozen = poolSetFrozenDetail(event, patch) ?? drawTypeFrozenDetail(event, patch)
  if (frozen !== null) return { ok: false, status: 409, detail: frozen }
  const next: StoredEvent = {
    ...event,
    name: patch.name ?? event.name,
    format: patch.format ?? event.format,
    draw_type: patch.draw_type ?? event.draw_type,
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
    pools: patch.pools ?? event.pools,
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

/** Why this event's pool SET may not be replaced right now, or `null` when it may be
 * (`_enforce_pool_set_frozen`, ADR-0786). Frozen only while a draw EXISTS — not while it
 * has been *played*: the two are different questions, and the morning of a tournament
 * (a draw cut, nothing played yet) is exactly when a blunt play-guard would wave through
 * an edit that orphans every fixture.
 *
 * Identity is all that is frozen. A `pools` payload carrying the same ids in a different
 * order, with different tables, different windows or different names, is fine. */
function poolSetFrozenDetail(
  event: StoredEvent,
  patch: TournamentEventUpdate,
): string | null {
  if (patch.pools === undefined || patch.pools === null) return null
  if (event.fixtures.length === 0) return null
  const before = new Set(event.pools.map((p) => p.id))
  const after = new Set(patch.pools.map((p) => p.id))
  const same =
    before.size === after.size && [...before].every((id) => after.has(id))
  if (same) return null
  return (
    "This event's draw is already cut, so its set of pools is frozen: " +
    'a pool cannot be added, removed or re-identified while fixtures refer to it. ' +
    'To add, remove or re-identify a pool, remove the draw first, then cut it again.'
  )
}

/** Why this event's `draw_type` may not be replaced right now, or `null` when it may be
 * (`_enforce_draw_type_frozen`, ADR-0786). The pool-set freeze's sibling, one field over:
 * a draw type is not a label on an event, it is the strategy that DEALT its fixtures, and
 * re-labelling it under a standing draw leaves the event claiming a shape its draw does
 * not have (a `single-elim` event holding pooled round-robin fixtures — the PATCH the
 * server used to answer **200**).
 *
 * **Presence is not enough — the CHANGE is what is refused.** The editor PATCHes the
 * whole form back, `draw_type` included, to move a pool's tables; a mock that fired on
 * the mere presence of the key would refuse the very edit the freeze exists to permit,
 * and the pools editor would look broken in `npm run dev` against a server that allows
 * it. */
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

/** A planned draw, or the server's sentence for why this event cannot be cut as it
 * stands. One value, because the refusal and the plan are the same decision: a shape that
 * asked "is it refused?" and then, separately, "plan it" could answer *no* to the first
 * and still have nothing to deal for the second. */
type DrawPlan =
  | { ok: true; fixtures: TournamentFixtureRead[] }
  | { ok: false; detail: string }

/** Plan an event's draw, or say why it cannot be — the planner's 422s, in the server's
 * own words (`app/draws.py`), because for these the sentence IS the answer: it names the
 * thing the director has to change.
 *
 * **Exhaustive over `DrawType`, with no default arm.** Every member of the enum has a
 * server-side strategy by construction (ADR 20260726), so there is no "this type cannot
 * be cut" refusal left to make — and adding a member tomorrow is a *type error* here
 * until it is given a planner, rather than a mock that quietly refuses a draw the server
 * would have dealt. */
function planDraw(event: StoredEvent): DrawPlan {
  // Entrants are ordered by SEED ascending where one is set, then by registration order
  // (ADR-0786) — the store lists them in registration order already, so this is a stable
  // sort that floats the seeded ones to the front. Nothing is random, so the same field
  // always cuts the same draw, and a re-cut of an unchanged field is a no-op in effect.
  const ordered = [...event.entrants].sort(
    (a, b) => (a.seed ?? Number.MAX_SAFE_INTEGER) - (b.seed ?? Number.MAX_SAFE_INTEGER),
  )
  const entryIds = ordered.map((e) => e.id)

  switch (event.draw_type) {
    case 'round-robin': {
      if (event.pools.length === 0) {
        return { ok: false, detail: 'A round-robin draw needs at least one pool.' }
      }
      const poolIds = event.pools.map((p) => p.id)
      const sizes = poolIds.map(
        (_, poolIndex) =>
          entryIds.filter((_entryId, index) => {
            const row = Math.floor(index / poolIds.length)
            const offset = index % poolIds.length
            const column = row % 2 === 0 ? offset : poolIds.length - 1 - offset
            return column === poolIndex
          }).length,
      )
      // Asked of the DEALT pools, not of arithmetic on N and P — the refusal is about the
      // pools the snake actually produced, and it names the numbers the director must
      // change.
      if (sizes.some((size) => size < 2)) {
        return {
          ok: false,
          detail:
            `${entryIds.length} entrants across ${poolIds.length} pool(s) would leave ` +
            'a pool with fewer than 2 entrants, who would have nobody to play.',
        }
      }
      return { ok: true, fixtures: planRoundRobinFixtures(entryIds, poolIds) }
    }
    case 'single-elim': {
      // Round-robin's per-pool floor, one level up: a bracket of one has no fixtures and
      // is not a competition. The event's POOLS are not consulted at all — a bracket is
      // un-pooled, so a single-elim event with pools cuts perfectly well and a
      // single-elim event with none is not refused, exactly as on the server.
      if (entryIds.length < 2) {
        return {
          ok: false,
          detail:
            'A single-elimination draw needs at least 2 entrants — a bracket of ' +
            'one has nobody to play.',
        }
      }
      return { ok: true, fixtures: planSingleElimFixtures(entryIds) }
    }
  }
}

/** `POST …/events/{event_id}/draw` — cut (or re-cut) an event's draw.
 *
 * **A re-cut replaces the draw wholesale**: the old fixtures are dropped and a fresh set
 * is planned from the event's *current* active entrants, so their ids do not survive.
 * That is the point — a draw is a plan made against a field, and once the field has
 * changed the whole plan is re-made, pool sizes and seeding included.
 *
 * The 422s are the planner's (see `planDraw`), and they are the ones a director actually
 * meets: a round-robin with no pools, a pool the snake would leave with fewer than two
 * entrants, and a bracket of fewer than two. **There is no draw-TYPE refusal**: both
 * members of `DrawType` have a strategy on the server (ADR 20260726) and both have a
 * planner here, so a mock that still refused single-elim would be putting a sentence in
 * the server's mouth that it can no longer say — and would make a single-elim cut
 * untestable in `npm run dev`, in vitest and in the browser at once. */
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
  const plan = planDraw(event)
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

/** The server's sentence for a placement that can no longer be changed, verbatim in
 * spirit (`api/app/tournaments.py`): a `completed`/`voided` match's table and time are
 * history. */
const PLACEMENT_FROZEN_DETAIL =
  "This match is finished, so its placement can no longer be changed."

/** `PATCH /v1/tournaments/{id}/fixtures/{fixtureId}/placement` — set (or clear) a
 * fixture's placement (ADR-0790). Creator-only (403), 404 for a fixture that is not on
 * any of the tournament's events.
 *
 * **Soft, deliberately**: an out-of-window time or a `table_id` that names no catalogue
 * table is *stored*, not refused — those are flags-on-read, a later scheduler slice. The
 * one refusal is a **409** on a fixture whose match is `completed`/`voided`; everything
 * else — no match yet, or `in_progress` — is freely (re)placeable.
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
// every unplaced fixture placed onto its pool's tables. Two reads is the demo loop —
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
