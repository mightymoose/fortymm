// Domain (camelCase) types for the tournament-admin UI. They mirror the design
// handoff; `./api` adapts them to/from the snake_case API wire shapes in
// `@/api/schema` (the data layer the route components read and write through).

// Type-only, and so fully erased: `./options` imports its domain types from
// here, but nothing crosses back at runtime.
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
  maxPlayers: number
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
