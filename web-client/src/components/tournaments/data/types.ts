// Domain (camelCase) types for the tournament-admin UI. They mirror the design
// handoff; `./api` adapts them to/from the snake_case API wire shapes in
// `@/api/schema` (the data layer the route components read and write through).

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

/** Eligibility-rule field keys understood by the predicate builder. */
export type PredicateField = 'age' | 'rating' | 'gender' | 'club'

/** A predicate's value: a number (most fields), an enum key (gender), a
 * boolean (club), or a `[min, max]` pair for the `between` operator. */
export type PredicateValue =
  | number
  | string
  | boolean
  | [number | null, number | null]
  | null

export interface Predicate {
  id: string
  field: PredicateField
  op: string
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

export interface TournamentEvent {
  id: string
  name: string
  format: EventFormat
  drawType: DrawType
  maxPlayers: number
  entryFee: number
  entered: number
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
