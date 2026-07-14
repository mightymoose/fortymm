// Domain (camelCase) types for the tournament-admin UI. They mirror the design
// handoff; `./api` adapts them to/from the snake_case API wire shapes in
// `@/api/schema` (the data layer the route components read and write through).

// Type-only, and so fully erased: `./options` imports its domain types from
// here, but nothing crosses back at runtime.
import type { MatchStatus } from '@/api/matches'

import type { PredicateOp } from './options'

export type TournamentStatus = 'draft' | 'published' | 'live' | 'archived'

export type EventFormat = 'singles' | 'doubles' | 'teams'

export type DrawType =
  | 'single-elim'
  | 'double-elim'
  | 'round-robin'
  | 'rr-then-ko'
  | 'swiss'

export type MatchLength = 1 | 3 | 5 | 7

/** A date-only (`YYYY-MM-DD`) window with `HH:MM` start/end. */
export interface Slot {
  date: string
  start: string
  end: string
}

export interface Address {
  venue: string
  street: string
  city: string
  region: string
  postal: string
  country: string
}

/** Eligibility-rule field keys understood by the predicate builder.
 *
 * **`rating` is the whole vocabulary** (ADR-0783): a rule may only name a fact
 * we actually hold about a player, and `age`, `gender` and `club` name nothing —
 * there is no date of birth, no gender and no club anywhere in the system. The
 * API's `Predicate.field` is `Literal["rating"]` and 422s the rest, so a builder
 * that still offered them would author payloads the server refuses. They come
 * back with the ticket that gives a player those attributes, and not before. */
export type PredicateField = 'rating'

/** A predicate's value: a number, or a `[min, max]` pair for the `between`
 * operator — those are the two shapes the one field (`rating`) takes, and `null`
 * is the rule whose value the organizer has not filled in yet.
 *
 * `string` and `boolean` are gone from the union, because they are gone from the
 * **wire**: the API now types `Predicate.value` as `int | list | null` (it
 * narrowed `value` as well as `field` — see `schema.d.ts`). They only ever
 * existed for the gender/club fields ADR-0783 removed, so a client that could
 * still hold one could only hold it to author a rule the server refuses. The
 * `(number | null)[]` the wire allows is narrowed to the `[min, max]` tuple by
 * `apiToPredicateValue` in `./api.ts`. */
export type PredicateValue = number | [number | null, number | null] | null

export interface Predicate {
  id: string
  field: PredicateField
  /** One of the seven operators the builder offers — **the operator table in
   * `./options.ts` is the definition** (`PredicateOp` is derived from it), and
   * the API's enum is its twin. Not `string`: an unknown operator must be a
   * compile error here, not a 422 at the far end of a save. */
  op: PredicateOp
  value: PredicateValue
}

export interface MatchSettings {
  rated: boolean
  lengthGames: MatchLength
}

/** A slice of tables reserved for a window of time within an event. */
export interface Pool {
  id: string
  name: string
  slot: Slot
  tableIds: string[]
}

/**
 * One planned pairing of an event's **draw** (ADR-0786): a round and a position —
 * plus a pool, when the draw is pooled — whose sides may still be unknown.
 *
 * A fixture is **not a match**. It materializes into one later (#788), and until it
 * does `matchId` is `null`. The whole set of an event's fixtures is its draw; an event
 * with no draw cut has `fixtures: []` (the designed empty state, never `null`).
 *
 * **Entrant names are deliberately not here.** A fixture carries entry *ids*, and the
 * usernames behind them are already on the page — the event's `entrants` list is keyed
 * by that very id — so a renderer joins the two. Copying the username onto the fixture
 * as well would be carrying a field and its own derivation, and the two copies would
 * drift the moment a player is renamed.
 *
 * The `null`s are all facts, and they are three different facts:
 * - `entryAId` / `entryBId` — **TBD**: the feeding fixture is not decided yet. Never a
 *   bye; a bye is the *absence of a fixture*, not a fixture with an empty side.
 * - `winnerEntryId` — undecided.
 * - `matchId` — not yet materialized.
 * - `matchStatus` — the live status of the materialized match, or `null` when there is
 *   no match yet. It moves in lockstep with `matchId` (both `null` before go-live, both
 *   set after), and it is the match's *current* status read live, never a copy frozen at
 *   go-live.
 * - `poolId` — this fixture belongs to no pool: the draw is un-pooled (single-elim), or
 *   this is the KO stage of an rr-then-ko. When set, it names a `Pool` in this same
 *   event's `pools`.
 *
 * Parsed at the boundary by `./fixtures` — this interface is what comes out.
 */
export interface Fixture {
  id: string
  poolId: string | null
  round: number
  position: number
  entryAId: string | null
  entryBId: string | null
  winnerEntryId: string | null
  matchId: string | null
  /** The materialized match's live status, or `null` until go-live (#788). Moves in
   * lockstep with `matchId`. */
  matchStatus: MatchStatus | null
}

/**
 * One entry's line in a pool's standings (ADR-0788), at the rank the **server**
 * settled it at.
 *
 * The entry is an **id only** — exactly as a fixture carries its sides — and the
 * username behind it is joined on at render from the event's `entrants` (the same
 * argument the draw makes: copying the username here would carry a field and its own
 * derivation, and the two would drift the moment a player is renamed). A row can name an
 * entry the event no longer lists — a player who withdrew after playing, whose completed
 * matches still count toward the numbers — so the join must have a word for that, never a
 * blank or a raw id.
 *
 * Every number is the **server's**, computed once on it and read straight through: the FE
 * neither re-sorts the rows nor recomputes a figure (ADR-0788 — "the order *is* the
 * result"). `gameDifference` (= `gamesWon - gamesLost`) rides along already reduced,
 * because it is the third tiebreaker and a client shows it, and computing it here as well
 * would be a second copy that could disagree with the two counts beside it.
 */
export interface StandingRow {
  entryId: string
  /** 1-based and distinct per row — position 1 is the pool leader. */
  rank: number
  played: number
  wins: number
  losses: number
  gamesWon: number
  gamesLost: number
  gameDifference: number
}

/** One pool's standings: its rows in the server's finishing order (**never re-sorted on
 * the client**), and whether every one of the pool's fixtures is decided. `poolId` names
 * a `Pool` in this same event's `pools`, so the table titles itself from the pool the
 * page already holds. */
export interface PoolStandings {
  poolId: string
  rows: StandingRow[]
  complete: boolean
}

/**
 * A round-robin event's **results** (ADR-0788): a standings table per pool, whether the
 * whole event is decided, and its champion when there is one.
 *
 * Derived **live** on the server from the fixtures' currently-`completed` matches — never
 * a snapshot — so a corrected or voided match re-orders the standings the instant it
 * leaves `completed`. On the FE it is just BFF data, so TanStack Query invalidation drives
 * the live update; nothing here polls or recomputes.
 *
 * On the event it is `null` for an event with **no draw** (nothing to stand) or one whose
 * draw type has no results strategy yet (only round-robin does today) — an honest "no
 * results", never an empty table that would read as a played event with nobody in it.
 */
export interface EventResults {
  pools: PoolStandings[]
  /** True when every fixture of every pool is decided. */
  complete: boolean
  /** The winning **entry id** of a complete, single-pool event — a pure round-robin's
   * winner. `null` while any fixture is unplayed, and `null` for a multi-pool event,
   * which has no single champion without a knockout stage to join its pool winners
   * (a later slice). Joined to a username at render, like a row's `entryId`. */
  champion: string | null
}

/** One *active* entry in an event. Withdrawn entries are not entrants — they
 * appear in neither this list nor the `entered` count (ADR-0016).
 *
 * `id` is the ENTRY's id, not the player's: it's the address a withdrawal is
 * sent to, so an entrant you can see is an entrant you can act on. */
export interface Entrant {
  id: string
  userId: string
  username: string
  seed: number | null
  /** This entrant's rating **on the tournament's ladder** (ADR-0783 §2: every
   * tournament names the league its eligibility is judged on), or `null` when
   * they hold none — they are **unrated** there.
   *
   * ⚠️ `null` IS the unrated state, and it is the SERVER's judgement, not a
   * nullable column echoed onto the wire. A brand-new player is seeded 1500 on
   * sign-up, so "unrated" is `is_rated_member()` — a rating value *and* a
   * non-`initial` history row *and* not a merged tombstone. The client neither
   * re-derives that nor second-guesses it: it reads `null` and says so
   * (`isUnrated`, `./helpers`).
   *
   * Why the client is told at all: an unrated player **passes every rating rule**
   * (ADR-0783 §3), which makes a rating cap opt-out. The agreed mitigation is that
   * an unrated entrant is *marked as such in the entrants list*, so the one person
   * who can act on a ringer — the director, who may withdraw them — can see who
   * took the opt-out. An invisible loophole and a visible one are different
   * things. */
  rating: number | null
}

/**
 * What the **event itself** has to say about the signed-in caller entering it —
 * the server's judgement, current-user-aware, arriving on the event (ADR-0783:
 * "eligibility is computed in exactly one place… the client never re-derives it
 * from the raw `predicates` JSON").
 *
 * It answers only the two questions the *event* can answer — is there room, and
 * does your rating satisfy its rules. It is deliberately NOT "can I click
 * Enter?": the registration *window* is a fact about the **tournament** (its
 * status, ADR-0017) and your own membership is a fact about the **entrants
 * list**, both of which are already on the payload. `entryControlState`
 * (`./lifecycle`) is what puts all three together.
 *
 * The `state` literals are the **entry refusal codes** (`./entry-refusal`,
 * ADR-0968), by design: the reason we learned on page load and the reason we
 * learn from a 409 on `POST …/entries` are the same reason, so they are the same
 * word and they share one copy table. Two tables would drift.
 */
export type EventEntryState =
  /** Room, and your rating passes every rule. (An *unrated* player passes every
   * rule — ADR-0783 §3.) */
  | { state: 'open' }
  /** `max_players` active entrants already. Nothing about *you*: the one arm of
   * the union that is a fact about the event alone. */
  | { state: 'event_full' }
  /** Your rating fails one of the event's rules — the *first* one it fails
   * (rules are ANDed). */
  | {
      state: 'rating_ineligible'
      /** WHICH rule refused you: it addresses a `Predicate` in this same event's
       * `predicates`, which the card already holds and already renders as chips.
       * The rule's `op`/`value` are not repeated here — that would be a field and
       * its own derivation, and the two copies could disagree. */
      predicateId: string
      /** The rating you were judged on, on the tournament's ladder. The client
       * cannot derive it (a player's rating on that league is nowhere else on this
       * page), and "you are not eligible" without it is a fact the player cannot
       * act on. */
      rating: number
    }

export interface TournamentEvent {
  id: string
  name: string
  format: EventFormat
  drawType: DrawType
  /** The entrant cap, or `null` for an uncapped event. `null` means "no cap",
   * never zero (ADR-0935): a blank player-limit field submits `null`, and every
   * reader must handle the no-cap branch rather than dividing by it. */
  maxPlayers: number | null
  entryFee: number
  /** The registration count. Server-derived from the active entries — it is
   * `entrants.length`, never a stored counter, so the count and the list it
   * counts cannot disagree. Read it; never write it. */
  entered: number
  entrants: Entrant[]
  /** What this event says about *the signed-in caller* entering it — server-
   * computed, never re-derived here (ADR-0783). Read it; never write it. */
  entryState: EventEntryState
  slot: Slot
  predicates: Predicate[]
  match: MatchSettings
  pools: Pool[]
  /** This event's **draw** — every fixture the cut produced, in pool → round → position
   * order, as the server sends them (ADR-0786).
   *
   * **`[]` is the designed "no draw cut" state**, and it is the state every event is
   * born in: cutting is an explicit, reviewable act (`POST …/draw`), and nothing else
   * creates fixtures. Read it; never write it — a draw changes only through the two
   * draw verbs, never through an event PATCH (which is why `eventToUpdateBody` omits
   * it, exactly as it omits the server-derived `entered`). */
  fixtures: Fixture[]
  /** This event's **results** — its pool standings, whether it is complete, and its
   * champion (ADR-0788) — or `null` for an uncut or non-round-robin event (nothing to
   * stand). Server-derived, live, from the fixtures' completed matches; read it, never
   * write it, and never re-sort or recompute it (the order and the numbers *are* the
   * result). */
  results: EventResults | null
}

/** A physical table in the venue catalogue, referenced by id from a
 * tournament's `tableIds` and a pool's `tableIds`. */
export interface TournamentTable {
  id: string
  label: string
  court: string
}

export interface Tournament {
  id: string
  name: string
  status: TournamentStatus
  /** True when the current user may edit/delete this tournament; the API's
   * `can_edit`. Gates every mutation affordance — a non-creator sees the
   * read-only view. */
  canEdit: boolean
  /** Authoritative dates are derived from the event schedule; these are the
   * seeded fall-backs shown before any event exists. */
  startDate: string | null
  endDate: string | null
  description: string
  address: Address
  tableIds: string[]
  events: TournamentEvent[]
}
