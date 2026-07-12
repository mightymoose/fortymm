// Dev-only in-memory store backing the MSW `/v1/tournaments` handlers. There is
// no backend in `npm run dev`: the seed loads once, mutations rewrite this
// module's array, and everything resets on reload. PATCH/DELETE (tournament and
// event) enforce the same creator-only rule the real API does — a
// `can_edit: false` row (created by someone else) returns 403.
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
import { entryStateFor } from '@/mocks/factories/tournaments/tournament.factory'

type TournamentDetailRead = components['schemas']['TournamentDetailRead']
type TournamentRead = components['schemas']['TournamentRead']
type TournamentStatus = components['schemas']['TournamentStatus']
type TournamentEventRead = components['schemas']['TournamentEventRead']
type TournamentCreate = components['schemas']['TournamentCreate']
type TournamentUpdate = components['schemas']['TournamentUpdate']
type TournamentEventCreate = components['schemas']['TournamentEventCreate']
type TournamentEventUpdate = components['schemas']['TournamentEventUpdate']
type TournamentTable = components['schemas']['TournamentTable']
type TournamentEntrantRead = components['schemas']['TournamentEntrantRead']

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
 * `rating_ineligible`. */
type StoredEvent = Omit<TournamentEventRead, 'entered' | 'entry_state'> & {
  /** Seeded: the dev user is refused by this rule, at this rating. */
  ineligible?: { predicate_id: string; rating: number }
}
type StoredTournament = Omit<TournamentDetailRead, 'events'> & {
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
      },
      table_catalogue: tables(12),
      created_by_user_id: DEV_USER_ID,
      created_by_username: DEV_USERNAME,
      can_edit: true,
      created_at: '2026-06-01T09:00:00Z',
      updated_at: '2026-06-10T12:00:00Z',
      events: [
        {
          id: 'ev-open-singles',
          tournament_id: 'bay-area-open-2026',
          name: 'Open Singles',
          format: 'singles',
          draw_type: 'rr-then-ko',
          max_players: 64,
          entry_fee: 45,
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
          created_at: '2026-06-01T09:05:00Z',
          updated_at: '2026-06-09T12:00:00Z',
        },
        {
          // Deliberately empty: the designed empty entrants state, and the event
          // whose count a dev demo ticks from 0 to 1.
          id: 'ev-u1500',
          tournament_id: 'bay-area-open-2026',
          name: 'U1500 Singles',
          format: 'singles',
          draw_type: 'rr-then-ko',
          max_players: 48,
          entry_fee: 30,
          entrants: [],
          slot: { date: '2026-06-14', start: '09:00', end: '16:00' },
          match_settings: { rated: true, length_games: 3 },
          predicates: [{ id: 'pr-2', field: 'rating', op: '<', value: 1500 }],
          pools: [],
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
          entrants: otherEntrants('ev-champ-singles', 16),
          slot: { date: '2026-06-14', start: '13:00', end: '18:00' },
          match_settings: { rated: true, length_games: 7 },
          predicates: [],
          pools: [],
          created_at: '2026-06-01T09:06:30Z',
          updated_at: '2026-06-09T12:00:00Z',
        },
        {
          // RATING-INELIGIBLE: the dev user is rated 1650 on the tournament's
          // ladder and this event admits only players under 1200, so the server
          // refuses them — naming the rule that did it (`predicate_id`), which the
          // card reads back out of the event's own `predicates`. Not derivable from
          // the event alone (there is no ladder in a mock), so it is seeded.
          id: 'ev-u1200',
          tournament_id: 'bay-area-open-2026',
          name: 'U1200 Singles',
          format: 'singles',
          draw_type: 'round-robin',
          max_players: 24,
          entry_fee: 20,
          entrants: otherEntrants('ev-u1200', 9),
          slot: { date: '2026-06-14', start: '09:00', end: '12:00' },
          match_settings: { rated: true, length_games: 3 },
          predicates: [{ id: 'pr-u1200', field: 'rating', op: '<', value: 1200 }],
          ineligible: { predicate_id: 'pr-u1200', rating: DEV_USER_RATING },
          pools: [],
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
          entrants: [],
          slot: { date: '2026-06-14', start: '10:00', end: '15:00' },
          match_settings: { rated: false, length_games: 3 },
          predicates: [],
          pools: [],
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
      },
      table_catalogue: tables(8),
      created_by_user_id: DEV_USER_ID,
      created_by_username: DEV_USERNAME,
      can_edit: true,
      created_at: '2026-06-05T15:30:00Z',
      updated_at: '2026-06-05T15:30:00Z',
      events: [],
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
      },
      table_catalogue: tables(10),
      created_by_user_id: 'u-office',
      created_by_username: 'league.office',
      can_edit: false,
      created_at: '2026-05-20T10:00:00Z',
      updated_at: '2026-06-12T08:00:00Z',
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
          created_at: '2026-05-20T10:05:00Z',
          updated_at: '2026-06-12T08:00:00Z',
        },
      ],
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
  return { ...t, events: t.events.map(readEvent) }
}

/** Reset the store to its seed — used by the dev worker bootstrap if needed, and
 * by tests that drive the store through the default handlers. */
export function resetTournamentsStore() {
  tournaments = seed()
}

/** The list, newest-created first (mirrors the API's ordering). */
export function listTournaments(): TournamentDetailRead[] {
  return tournaments
    .slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map(readDetail)
}

/** A single tournament's detail, or `undefined` if missing. */
export function findTournament(id: string): TournamentDetailRead | undefined {
  const found = tournaments.find((t) => t.id === id)
  return found === undefined ? undefined : readDetail(found)
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
    address: body.address,
    table_catalogue: body.table_catalogue ?? [],
    created_by_user_id: DEV_USER_ID,
    created_by_username: DEV_USERNAME,
    can_edit: true,
    created_at: now,
    updated_at: now,
    events: [],
  }
  tournaments = [created, ...tournaments]
  return readOf(created)
}

export type StoreResult =
  | { ok: true; tournament: TournamentRead }
  | { ok: false; status: 403 | 404 }

export type EventResult =
  | { ok: true; event: TournamentEventRead }
  | { ok: false; status: 403 | 404 }

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
 * `_get_tournament_or_404` + `_require_owner` (`api/app/tournaments.py`), in one
 * step, because every owner-only mutation asks the same two questions in the same
 * order — does it exist (**404**), and is it mine (**403**)?
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
    address: patch.address ?? existing.address,
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
 * tournament), 403 (not the owner), 409 (not a legal edge). The 409 carries the
 * server's `detail` verbatim, because the copy is what a stale tab is told. */
export type TransitionResult =
  | { ok: true; tournament: TournamentRead }
  | { ok: false; status: 403 | 404 }
  | { ok: false; status: 409; detail: string }

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
  const next: StoredTournament = {
    ...existing,
    status: to,
    updated_at: new Date().toISOString(),
  }
  replace(next)
  return { ok: true, tournament: readOf(next) }
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
    max_players: body.max_players,
    entry_fee: body.entry_fee,
    // A brand-new event has no entrants, so its derived count is 0. There is no
    // `entered` to set — that's the point.
    entrants: [],
    slot: body.slot,
    match_settings: body.match_settings,
    predicates: body.predicates ?? [],
    pools: body.pools ?? [],
    created_at: now,
    updated_at: now,
  }
  replace({ ...existing, events: [...existing.events, event] })
  return { ok: true, event: readEvent(event) }
}

/** Patch an event (full replace of the provided fields). Creator-only. */
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
  const next: StoredEvent = {
    ...event,
    name: patch.name ?? event.name,
    format: patch.format ?? event.format,
    draw_type: patch.draw_type ?? event.draw_type,
    max_players: patch.max_players ?? event.max_players,
    entry_fee: patch.entry_fee ?? event.entry_fee,
    // Entrants are not in the PATCH body — an editor edit never touches the
    // registrations, so the derived count survives the edit untouched.
    entrants: event.entrants,
    slot: patch.slot ?? event.slot,
    match_settings: patch.match_settings ?? event.match_settings,
    predicates: patch.predicates ?? event.predicates,
    pools: patch.pools ?? event.pools,
    updated_at: new Date().toISOString(),
  }
  replace({
    ...existing,
    events: existing.events.map((e) => (e.id === eventId ? next : e)),
  })
  return { ok: true, event: readEvent(next) }
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
