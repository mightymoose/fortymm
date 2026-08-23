// Domain (camelCase) types for the tournament-admin UI. They mirror the design
// handoff; `./api` adapts them to/from the snake_case API wire shapes in
// `@/api/schema` (the data layer the route components read and write through).

// Type-only, and so fully erased: `./options` imports its domain types from
// here, but nothing crosses back at runtime.
import type { MatchStatus } from '@/api/matches'

import type { DrawType, DrawTypeOption, StageDrawType } from './draw-types'
import type { PredicateOp } from './options'
import type { ScheduleSolve } from './solve'

export type TournamentStatus = 'draft' | 'published' | 'live' | 'archived'

export type EventFormat = 'singles' | 'doubles' | 'teams'

/** The draw-type vocabulary is declared **once**, next to its Zod schema and the
 * catalogue parser (`./draw-types`), the way `./solve` declares its enums. Re-exported
 * here so the domain modules that read every tournament type from `./types` keep doing
 * so — there is no second declaration to drift. */
export type { DrawType, DrawTypeOption, StageDrawType }

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
  /** Server-geocoded at write time and **NOT NULL** on the read schema — mirrors
   * `Address` in `schema.d.ts` (the ADR "a venue's coordinates are geocoded
   * server-side at write time and are NOT NULL"). The *write* shape a client
   * sends (`AddressInput`) has no coordinates; a client never supplies these.
   * The read model always carries them, so downstream readers (distance badge,
   * map) can rely on non-null coordinates rather than threading `number | null`. */
  latitude: number
  longitude: number
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

/** One competitive **group** of an event's draw — an ordered set of entrants who play
 * all-play-all — as it is **read**: server-minted identity and order, plus which
 * reservation it plays under (ticket #1369, "group and reservation").
 *
 * Server-owned, unlike `Reservation` below — there is no write shape, because a client
 * never authors a group directly. The server materialises the group rows on every
 * event write (ticket #1387): for an `rr-then-ko` event, `ceil(field / 5)` against the
 * preview field; for every other draw type, one group per reservation. Each group maps
 * to the reservation at `position % reservation count`.
 *
 * `reservationId` names an entry of this same event's `reservations`, or is `null` for
 * a group that plays in no reservation (every group of an event with no reservation).
 * A non-null id is never a dangling ref — the join row behind it is a real foreign
 * key — but the client still looks it up rather than assuming it always resolves
 * (`eventSchema`/`apiToEvent`, `./api`, reject a payload where it does not). */
export interface Group {
  id: string
  /** Where this group sits in its event's ordering — 0-based, and assigned by the
   * server (`groupLetter`, `./draw-structure`, is what turns this into `Group A`,
   * `Group B`, …). */
  position: number
  /** The reservation this group plays under — the id to look up in this same event's
   * `reservations` for its tables, its window and the name a director typed — or
   * `null` when it plays in none, in which case it renders without a window and
   * without tables. */
  reservationId: string | null
}

/** A slice of tables reserved for a window of time within an event — the **venue**
 * face of what used to be one overloaded concept (ticket #1369) — **as it is read
 * back**: the words a client wrote, plus the two fields the server owns.
 *
 * This is the READ shape. What goes *out* is `ReservationDraft` below — the same
 * distinction `TournamentTable`/`TournamentTableEntry` draw one resource over, and for
 * the same reason: since ADR 20260801 a reservation is a row with a uuid primary key,
 * so neither of the two fields here is the client's to author. */
export interface Reservation {
  /** The SERVER's uuid — the `tournament_reservations` row's primary key (ADR
   * 20260801). A client never mints one: the create shape (`ReservationWrite`) has no
   * `id` field at all and `extra="forbid"` turns a supplied one into a 422, and the
   * patch shape (`ReservationUpsert`) takes an id only to *cite* a reservation the
   * event already has. An id this event does not hold is a 422 naming that entry —
   * never a quietly minted reservation. */
  id: string
  name: string
  slot: Slot
  tableIds: string[]
  /**
   * Where this reservation sits in its event's ordering — **0-based, and assigned by
   * the server** from the index of the reservation in the list a write body sent. To
   * reorder reservations you send them in the order you want; you never send a
   * position (both write schemas are `extra="forbid"`, so a `position` key on a write
   * body is a 422 that names the field — see `reservationEntriesToApi`, `data/api`).
   *
   * It exists because **reservation ids do not order reservations**, and that was true
   * of the client-minted ids it was introduced against (`p-10-…` sorted between
   * `p-1-…` and `p-2-…`, so a ten-reservation event read its draw back as 1, 10, 2, 3 —
   * a live bug) and is even more true of the uuids that replaced them, which sort by
   * nothing at all. Everything that puts reservations in an order therefore orders
   * them by THIS field (`inPositionOrder`, `data/helpers`) — never by id, and never by
   * whatever order the array happened to arrive in.
   */
  position: number
}

/** The part of a reservation a client actually **authors**: what it is called, when it
 * runs, and which tables it holds. Exactly `ReservationWrite` on the wire — no `id`, no
 * `position`, because neither is the client's (see `Reservation` above). It is also all
 * a reservation card is given, so the editor's one reservation control literally cannot
 * touch an identity. */
export interface ReservationDraft {
  name: string
  slot: Slot
  tableIds: string[]
}

/**
 * One reservation of an **edited** event — what the editor's Reservations tab holds
 * and `reservationEntriesToApi` (`./api`) puts on the wire as a `ReservationUpsert`.
 *
 * A reservations write is an **id-keyed diff**, not a replace (ADR 20260801), and the
 * two things an entry can mean are opposite:
 *
 * - **`kept`** — "this is the reservation you already have, with these words." It
 *   carries the `id` the server minted, so the row keeps its identity — and, with it,
 *   the group mapped 1:1 onto it, and every fixture drawn into that group.
 * - **`added`** — "mint me one." It has no `id` **field at all**, so a client-minted id
 *   is not a value this type can hold — which is the point: `ReservationWrite` is
 *   `extra="forbid"`, so an `id` on a new reservation is a 422, and an entry citing an
 *   id the event does not have is a 422 on that entry (`['body','reservations',i,'id']`).
 *
 * (And a stored reservation **no entry cites** is a *removal* — which is why this is a
 * tagged union rather than the obvious `id?: string`. With one optional field, a draft
 * reservation that had somehow acquired an id and a saved reservation that had lost one
 * are both representable, and each is a silent data-loss bug: the first is a 422 at
 * best and a duplicate reservation at worst, the second deletes the reservation — and
 * its mapped group's fixtures' home — that the director only meant to rename. It is
 * the shape `TournamentTableEntry` already has, one resource over.)
 *
 * `key` on the `added` arm is a **React key and nothing else**: it is never sent, never
 * read by the server, and never mistaken for an id, because the arm that has an id is a
 * different arm. The cards need a stable key across re-renders — `useFieldArray`
 * regenerates its own key on every `update()`, which would remount the card mid-keystroke
 * and drop focus — and a reservation the server has never seen has nothing else to be
 * keyed on.
 */
export type ReservationEntry =
  | ({ kind: 'kept'; id: string } & ReservationDraft)
  | ({ kind: 'added'; key: string } & ReservationDraft)

/**
 * An event as the **editor** hands it back: every read field of the event it was opened
 * on, with the reservations replaced by the diff the organizer built (`ReservationEntry`).
 *
 * It is a distinct type from `TournamentEvent` rather than a loosened one so that the
 * two directions cannot be confused at a call site: what comes *back* from the API has
 * reservations with server ids and positions, and what goes *out* has entries that
 * either cite an id or carry none. `eventToCreateBody` / `eventToUpdateBody` take this,
 * so an event read straight off a query can no longer be posted back as-is — which is
 * exactly the 422 (`extra_forbidden` on `body.reservations[i].id`) that this shape
 * exists to make unsayable.
 *
 * `groups` rides along unchanged from the read event — a director never edits it
 * directly, and it is not part of the diff a save sends. */
export type EditedEvent = Omit<TournamentEvent, 'reservations'> & {
  reservations: ReservationEntry[]
}

/**
 * One stage of an event's draw (ADR 20260815 decision 1): a row the event owns, never
 * authored by a director. The system mints an event's stages from a template keyed on
 * its (possibly composite) `drawType` the moment its draw settings are configured:
 * `round-robin → [round-robin]`, `single-elim → [single-elim]`, `swiss → [swiss]`,
 * `rr-then-ko → [round-robin, single-elim]` — so every event holds at least one stage
 * from the moment it exists, and stages freeze the same instant a draw does (the groups
 * freeze, decision 3).
 *
 * `drawType` is the stage's OWN draw type — the strategy it runs — and it is one of the
 * three **single-stage** kinds, never `rr-then-ko`: that member names a template, a
 * sequence of stages, not a runnable stage's own type (decision 4). This is what lets
 * `shapeForStage` (`./draw`) be a three-arm exhaustive switch with nothing to guess at.
 */
export interface Stage {
  id: string
  /** 0-based order among this event's stages — `round-robin` before `single-elim` for
   * an `rr-then-ko` event's two. */
  position: number
  drawType: StageDrawType
}

/**
 * One planned pairing of an event's **draw** (ADR-0786): a round and a position —
 * plus a group, when the draw is grouped — whose sides may still be unknown.
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
 * - `stageId` — the **stage** (ADR 20260815 decision 5) this fixture belongs to —
 *   `NOT NULL`, and never inferred: it names an entry in this same event's `stages`.
 *   Read that stage's own `drawType` to answer "is this fixture's un-grouped block a
 *   bracket or a set of swiss rounds?" (`shapeForStage`, `./draw`) — a client no longer
 *   guesses that from `groupId` plus the event's overall `drawType`, which is exactly
 *   the inference that once rendered a swiss draw's rounds as a knockout bracket,
 *   because both are un-grouped and indistinguishable by `groupId` alone.
 * - `groupId` — this fixture belongs to no group: the draw is un-grouped (single-elim,
 *   swiss), or this is the knockout stage of an `rr-then-ko` draw. Which one is no
 *   longer this field's business to say — read `stageId` against `stages` for that.
 *   When set, it names a `Group` of **this fixture's own stage**, in this same event's
 *   `groups` — but a fixture whose `groupId` names no entry of `groups` is still shown,
 *   never dropped and never a parse failure (the domain allows a knockout fixture that
 *   simply names no group): see `drawState`, `./draw`.
 * - `tableId` — the fixture's **placement** table (ADR-0790): `null` means **unassigned
 *   to a table**. When set, it names a `TournamentTable` in the tournament's table
 *   catalogue — a string ref, the same pattern as `groupId`.
 * - `scheduledStart` — the placement's **predicted** start (ADR "tournament times are
 *   timezone-aware instants"): `null` means **unscheduled**. When set, a `FixtureTime`
 *   — a venue-local `localLabel`/`tzAbbrev` for display plus the raw UTC `instant` for
 *   tz-agnostic geometry — a prediction, not a commitment.
 * - `pinnedAt` — when the fixture was **called** (ADR "the schedule is solved, the
 *   call is pinned"): `null` means the placement is still an estimate the solver may
 *   move freely. When set, the placement is a promise — the players were notified,
 *   and no later solve rearranges it. A `FixtureTime`, like `scheduledStart`.
 * - `completedAt` — the match's **actual** completion time, as opposed to
 *   `scheduledStart`'s *predicted* one: `null` until the match is actually decided
 *   (win or void). A `FixtureTime`, like `scheduledStart`/`pinnedAt` — this is what
 *   a Gantt-style schedule view uses as a played slot's real end, instead of
 *   projecting the estimated duration past a match that has already finished.
 *
 * Parsed at the boundary by `./fixtures` — this interface is what comes out.
 */
export interface Fixture {
  id: string
  /** The stage (`Stage`, ADR 20260815) this fixture belongs to — never `null`, an
   * entry in this same event's `stages`. */
  stageId: string
  groupId: string | null
  round: number
  position: number
  entryAId: string | null
  entryBId: string | null
  winnerEntryId: string | null
  matchId: string | null
  /** The materialized match's live status, or `null` until go-live (#788). Moves in
   * lockstep with `matchId`. */
  matchStatus: MatchStatus | null
  /** The placement table this fixture is assigned to (ADR-0790), or `null` when
   * **unassigned**. A string ref into the tournament's table catalogue, like `groupId`. */
  tableId: string | null
  /** The placement's predicted start (ADR "tournament times are timezone-aware
   * instants"): a `FixtureTime`, or `null` when **unscheduled**. A prediction, not a
   * commitment. */
  scheduledStart: FixtureTime | null
  /** When this fixture was **called** — pinned and its players notified — or `null`
   * while the placement is still an estimate (ADR "the schedule is solved, the call
   * is pinned"). A `FixtureTime` when set. */
  pinnedAt: FixtureTime | null
  /** How many call/correction notifications this fixture's players have received.
   * `0` for a never-called fixture. Read-only, like `pinnedAt`. */
  callNotifiedCount: number
  /** The match's actual completion time, or `null` until it is decided (win or
   * void). A `FixtureTime`, like `scheduledStart`/`pinnedAt`. Read-only. */
  completedAt: FixtureTime | null
}

/**
 * One displayed tournament time (ADR "tournament times are timezone-aware instants",
 * superseding ADR-0790's naive-wall-clock frame). The server does **all** the timezone
 * arithmetic and ships a client three things about one moment:
 *
 * - `instant` — the absolute moment as an unambiguous UTC ISO-8601 string (ends with
 *   `Z`). This — and only this — is what a Gantt bar's geometry differences: subtracting
 *   two instants is tz-agnostic, so positioning needs no timezone library.
 * - `localLabel` — the moment already rendered in the **event's venue timezone**, as a
 *   12-hour wall-clock with no zone suffix (e.g. `"6:00 PM"`). The client displays it
 *   verbatim — it never slices a datetime or picks a zone.
 * - `tzAbbrev` — the DST-correct zone abbreviation (e.g. `"CDT"`). Rendered right beside
 *   `localLabel` (`{localLabel} {tzAbbrev}` → `"6:00 PM CDT"`) so that a tournament-wide
 *   board showing events in different timezones never lets two same-column bars imply the
 *   same instant.
 *
 * Carrying both label and instant is not a field and its own derivation: the label is for
 * reading and the instant is for math, and neither is derivable from the other without the
 * timezone library this model exists to keep off the client.
 */
export interface FixtureTime {
  instant: string
  localLabel: string
  tzAbbrev: string
}

/**
 * One entry's line in a group's standings (ADR-0788), at the rank the **server**
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
  /** 1-based and distinct per row — position 1 is the group leader. */
  rank: number
  played: number
  wins: number
  losses: number
  gamesWon: number
  gamesLost: number
  gameDifference: number
}

/**
 * One entry's line in a **swiss** table: every column a group's row carries, plus the
 * **Buchholz** figure that ordered it (ADR "swiss standings add Buchholz, and head-to-head
 * is guarded on having met").
 *
 * It **extends** `StandingRow` rather than restating it, exactly as `SwissStandingRowRead`
 * extends `StandingRowRead` on the wire: swiss's rows are a group's rows plus one column,
 * which is a fact about the format and not a second row shape. So one table renders both.
 */
export interface SwissStandingRow extends StandingRow {
  /**
   * The sum of this entrant's **opponents' win counts** — how strong a field they had to
   * beat, and the tiebreak that sits **above game difference** in swiss (CONTEXT.md,
   * "Buchholz"). Highest first.
   *
   * It is on the wire because it is the one link in the chain a client cannot re-derive
   * from the row it ordered: every other step shows its working in the columns beside it,
   * so a table that ranks A above B on equal wins and *worse* game difference is
   * unreadable without this number.
   *
   * Two properties worth not breaking in the UI:
   *
   * - the wins it sums are the **wins this same table shows, bye wins included**, so a
   *   director can check the figure by adding up the win columns of the players this one
   *   has played. An adjusted number would silently fail that arithmetic and read as a bug;
   * - a **bye adds no term** to its own holder's sum, having produced no opponent.
   *
   * It **moves as the event runs**: an opponent winning a later match raises it without
   * this entrant playing. Like every other figure here it is the SERVER's, shown and never
   * recomputed.
   */
  buchholz: number
}

/** One group's standings: its rows in the server's finishing order (**never re-sorted on
 * the client**), and whether every one of the group's fixtures is decided. `groupId` names
 * a `Group` in this same event's `groups`, so the table titles itself from the group the
 * page already holds — via `groupLetter` (`./draw-structure`), since a group carries no
 * name of its own. */
export interface GroupStandings {
  groupId: string
  rows: StandingRow[]
  complete: boolean
}

/**
 * A round-robin event's **results** (ADR-0788): a standings table per group, whether the
 * whole event is decided, and its champion when there is one. The `standings` arm of the
 * `EventResults` discriminated union (ADR-0785), tagged `kind: 'standings'`.
 *
 * Derived **live** on the server from the fixtures' currently-`completed` matches — never
 * a snapshot — so a corrected or voided match re-orders the standings the instant it
 * leaves `completed`. On the FE it is just BFF data, so TanStack Query invalidation drives
 * the live update; nothing here polls or recomputes.
 */
export interface StandingsResults {
  kind: 'standings'
  groups: GroupStandings[]
  /** True when every fixture of every group is decided. */
  complete: boolean
  /** The winning **entry id** of a complete, single-group event — a pure round-robin's
   * winner. `null` while any fixture is unplayed, and `null` for a multi-group event,
   * which has no single champion without a knockout stage to join its group winners
   * (a later slice). Joined to a username at render, like a row's `entryId`. */
  champion: string | null
}

/**
 * One entrant's **finish** in a single-elimination bracket (ADR-0785): the finishing
 * position the server derived from the round it was eliminated in.
 *
 * The entry is an **id only** — exactly as a standings row and a fixture are — joined to a
 * username at render from the event's `entrants` (copying the name onto the row would carry
 * a field and its own derivation, and the two would drift when a player is renamed).
 *
 * `position` is 1-based and **shared by same-round losers**: the two semifinal losers both
 * carry `3`, the four quarterfinal losers `5`. It is deliberately *not* distinct per row —
 * single-elimination does not rank same-round losers against each other, so a shared
 * position is honest, and the client renders those as a tie (e.g. `T3`), never inventing an
 * order the format never produced. It is the **server's** figure; the client shows it and
 * never computes a placement of its own.
 */
export interface FinishRow {
  entryId: string
  /** 1-based finishing position; `1` is the champion. Shared by same-round losers. */
  position: number
  /** The 1-based round the entrant lost in, or `null` for the champion (never eliminated).
   * Carried for completeness; the placement list keys off `position`. */
  eliminatedInRound: number | null
}

/**
 * A single-elimination event's **results** (ADR-0785): its **finishes** — a placement list
 * derived live from the bracket, whether the whole bracket is decided, and its champion
 * when the final is. The `finishes` arm of the `EventResults` discriminated union, tagged
 * `kind: 'finishes'`.
 *
 * Only *placed* entrants appear: every loser of a decided fixture, plus the champion once
 * the final is decided. An entrant still alive in a partially-played bracket has no finish
 * yet and is simply **absent** — a partial, live result the client renders as-is (it never
 * computes a placement). Like every results shape it is derived live, so a correction or
 * void re-derives it (and can re-crown) with no snapshot.
 */
export interface FinishesResults {
  kind: 'finishes'
  /** In the server's order — **position ascending, ties sharing a position** — rendered
   * untouched (the order *is* the result). */
  finishes: FinishRow[]
  /** True when the final is decided (the whole bracket is played out). */
  complete: boolean
  /** The champion's **entry id** — the final's winner (finish position 1) — or `null` until
   * the final is decided. Joined to a username at render, like a row's `entryId`. */
  champion: string | null
}

/**
 * A **round-robin-then-knockout** event's results (ADR 20260727): both stages at once —
 * the group stage's standings and the knockout stage's finishes. The
 * `standings_then_finishes` arm of the `EventResults` discriminated union.
 *
 * Its two blocks are the **same models** the other two arms send (`GroupStandings[]`,
 * `FinishRow[]`), not two-stage-flavoured near-copies, so each stage renders through the
 * panel that already exists and the shapes cannot drift apart. That is also why this is a
 * third arm rather than a restructuring of the union into a composite: making `standings`
 * and `finishes` sub-objects of one wrapper would change how the existing two arms are
 * read, forcing round-robin and single-elim changes that buy nothing.
 *
 * Live and partial like every other results shape: the group tables fill in as group
 * matches land, and the finishes list grows as the bracket is played out — so a mid-flight
 * event has complete groups and a finishes list that **starts below 1st** (only the
 * entrants the bracket has actually placed).
 */
export interface StandingsThenFinishesResults {
  kind: 'standings_then_finishes'
  /** The **group stage**: one standings table per group, in the server's finishing order. */
  groups: GroupStandings[]
  /** The **knockout stage**: the placements so far, position ascending, ties sharing a
   * position — exactly what a single-elimination event reads out. Empty until the bracket
   * settles its first fixture. */
  finishes: FinishRow[]
  /** True when **both** stages are decided — every group played out *and* the bracket run
   * to its final. Not either one: a two-stage event with decided groups and an unplayed
   * final is not complete. */
  complete: boolean
  /** The winning **entry id** — the **knockout final's winner, never a group leader**. The
   * group stage only seeds the bracket, so topping a group wins nothing here. `null` until
   * that final is decided. Joined to a username at render, like a row's `entryId`. */
  champion: string | null
}

/**
 * A **swiss** event's results (ADR "swiss pre-cuts every round and pairs each one on
 * advance"): **one standings table over the whole field**, whether every round is decided,
 * and the leader once it is. The `swiss_standings` arm of the `EventResults` union.
 *
 * The rows are a round-robin group's rows **plus one column** (`SwissStandingRow`), not a
 * swiss-flavoured near-copy — so the same table renders them and the two shapes cannot
 * drift apart. The two differences are both facts about the format: they arrive as **one
 * list rather than grouped under a group** (swiss is group-less — everybody is ranked
 * against everybody, which is what pairing by score is for), and each carries the
 * **Buchholz** figure that ordered it, which a round-robin has no use for because its
 * entrants all face the same opposition.
 *
 * Live and partial like every other results shape: the table fills in as matches land, and
 * the later rounds — cut up front with their sides still unknown — contribute nothing until
 * they are paired and played.
 */
export interface SwissStandingsResults {
  kind: 'swiss_standings'
  /** The whole field in the server's finishing order, **never re-sorted here** (the order
   * *is* the result — ADR-0788). One list, because there is no group to group by; and each
   * row carries its `buchholz`, because that is the step of the chain the other columns
   * cannot show. */
  rows: SwissStandingRow[]
  /** True when **every round** is decided, the later ones included. */
  complete: boolean
  /** The leader's **entry id** once the event is complete, else `null`. A swiss ranks its
   * whole field, so unlike the round-robin arm there is no multi-group carve-out: a complete
   * swiss always has one. Joined to a username at render, like a row's `entryId`. */
  champion: string | null
}

/**
 * An event's **results**, a discriminated union tagged by shape (ADR-0785, widened by ADR
 * 20260727 and by the swiss ADR): `standings` for round-robin, `finishes` for
 * single-elimination, `standings_then_finishes` for round-robin-then-knockout, and
 * `swiss_standings` for swiss. Each draw type's results strategy returns its own shape; the
 * BFF emits the `kind` tag; the client switches on it. A future draw type is a type error
 * until it declares its shape.
 *
 * On the event it is `null` for an event with **no draw** — nothing to stand — an honest
 * "no results", never an empty table that would read as a played event with nobody in it.
 * Every draw type a director can pick reads out results of one of these shapes, so
 * "cut, but no results block" is not a state.
 */
export type EventResults =
  | StandingsResults
  | FinishesResults
  | StandingsThenFinishesResults
  | SwissStandingsResults

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
  /** **K** — how many of each group's finishers advance into the knockout stage of an
   * `rr-then-ko` draw, or `null` for a draw type that has no knockout stage to qualify
   * for (ADR 20260727).
   *
   * ⚠️ `null` is not "unset" — it is the **only** legal value for `round-robin`,
   * `single-elim` and `swiss`, and the server says so at the request boundary: the draw
   * configuration is a union tagged by the draw type, and the three count-less arms are
   * `extra="forbid"`, so a qualifier count sent alongside any of them is a 422 rather
   * than a value quietly dropped. That is why `eventToApiFields` (`./api`) **omits** the
   * key for those three types instead of sending `null` — and why the editor's control
   * for it is rendered only for `rr-then-ko`.
   *
   * For `rr-then-ko` it is **required**, at least 1, and it is not a number this client
   * may assume: "2" is a convention, not a fact about the event, and a bracket cut for a
   * K the director never chose is the failure that looks like it worked. It is also what
   * sizes the bracket (`P × K`), which is why it is carried on the read model at all —
   * the mock planner and every reader take the director's real value rather than a
   * default. */
  qualifiersPerGroup: number | null
  /** **R** — how many rounds a `swiss` event plays, or `null` for a draw type whose round
   * count is not a thing anybody chooses (ADR "swiss pre-cuts every round and pairs each
   * one on advance").
   *
   * ⚠️ `null` is not "unset" — it is the **only** legal value for the other three draw
   * types, and the server says so at the request boundary the same way it does for the
   * qualifier count: the draw configuration is a union tagged by the draw type, and the
   * three round-count-less arms are `extra="forbid"`, so a `rounds` sent alongside any of
   * them is a 422 rather than a value quietly dropped. That is why `eventToApiFields`
   * (`./api`) **omits** the key for those three instead of sending `null` — and why the
   * editor's control for it is rendered only for `swiss`.
   *
   * For `swiss` it is **required**, and it is not a number this client may assume:
   * `ceil(log2 n)` is the convention, and deliberately not a derived default — a director
   * books tables and a venue window before registration opens, so a round count that moved
   * as entrants arrived would change the length of a day that is already booked. It is also
   * what sizes the draw (`R × ⌊n/2⌋` fixtures, all cut up front), which is why it is
   * carried on the read model at all. */
  rounds: number | null
  /** The entrant cap, or `null` for an uncapped event. `null` means "no cap",
   * never zero (ADR-0935): a blank player-limit field submits `null`, and every
   * reader must handle the no-cap branch rather than dividing by it. */
  maxPlayers: number | null
  entryFee: number
  /** The IANA timezone (e.g. `America/Chicago`) that **anchors** this event's
   * wall-clock windows to real instants (ADR 20260719 — "tournament times are
   * timezone-aware instants"). `NOT NULL` on the server: a new event pre-fills it
   * from the browser's resolved zone (`browserTimezone`, `./helpers`), and every
   * displayed window carries it as a label so the director sees the frame the
   * `slot` times are in. The server does all timezone arithmetic; the client only
   * carries the name and shows it. */
  timezone: string
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
  /** This event's **groups** (ticket #1369) — the competitive face: server-minted
   * identity and order, one per reservation. Read-only; a client edits `reservations`
   * below and the server keeps this array in lockstep, one entry per reservation. */
  groups: Group[]
  /** This event's **reservations** (ticket #1369) — the venue face: the tables and
   * time window a director books, and the name they typed. What a client actually
   * edits (`ReservationEntry`, `EditedEvent`). */
  reservations: Reservation[]
  /** This event's **stages** (ADR 20260815) — one row per single-stage kind the event's
   * `drawType` template names, in `position` order. System-minted, never authored by a
   * director, and present from the moment the event exists (so an *undrawn* event still
   * has these). Frozen the instant a draw exists, the same moment the groups freeze. */
  stages: Stage[]
  /** This event's **draw** — every fixture the cut produced, in group → round → position
   * order, as the server sends them (ADR-0786).
   *
   * **`[]` is the designed "no draw cut" state**, and it is the state every event is
   * born in: cutting is an explicit, reviewable act (`POST …/draw`), and nothing else
   * creates fixtures. Read it; never write it — a draw changes only through the two
   * draw verbs, never through an event PATCH (which is why `eventToUpdateBody` omits
   * it, exactly as it omits the server-derived `entered`). */
  fixtures: Fixture[]
  /** This event's **results** — its group standings, whether it is complete, and its
   * champion (ADR-0788) — or `null` for an uncut or non-round-robin event (nothing to
   * stand). Server-derived, live, from the fixtures' completed matches; read it, never
   * write it, and never re-sort or recompute it (the order and the numbers *are* the
   * result). */
  results: EventResults | null
  /** The event's **optimistic-concurrency version** (#1499) — the number a PATCH must
   * send back for the server to accept the edit. Server-owned and read-only: a client
   * carries it across unread and unmodified, `eventToUpdateBody` sends it back
   * verbatim, and every accepted PATCH moves it on by one, on the server, whatever it
   * changed.
   *
   * A stale one — this event written elsewhere since this copy was read — is refused
   * with a coded 409 (`event_version_conflict`, `./save-failure`) rather than silently
   * overwriting the other write and, with it, whatever it touched (reservations
   * included, which takes the drawn fixtures with them). The event editor reads the
   * FRESH version live off the reconciled tournament — never off this frozen copy — to
   * offer a deliberate override (`tournament-detail-page.tsx`). */
  lockVersion: number
}

/** A physical table in the venue catalogue, referenced by id from a
 * tournament's `tableIds` and a reservation's `tableIds`.
 *
 * The `id` is the SERVER's — a uuid it minted for the `tournament_tables` row
 * (ADR 20260801). A client never authors one: this shape is what comes *back*, and
 * the shape that goes *out* is `TournamentTableEntry` below. */
export interface TournamentTable {
  id: string
  label: string
  court: string
}

/**
 * One entry of an **edited** table catalogue — what the Tables tab emits and
 * `catalogueToUpdateBody` (`./api`) puts on the wire as a `TournamentTableUpsert`.
 *
 * A catalogue write is an **id-keyed diff**, not a replace (ADR 20260801), and the
 * two things an entry can mean are opposite:
 *
 * - **`kept`** — "this is the table you already have, with these words." It carries
 *   a whole `TournamentTable`, so it cannot be constructed without a row the server
 *   actually sent back.
 * - **`added`** — "mint me one." It has no `id` **field at all**, so a client-minted
 *   id is not a value this type can hold — which is the point: `TournamentTableWrite`
 *   is `extra="forbid"`, so an `id` on a new entry is a 422, and an entry citing an
 *   id the tournament does not have is a 422 on that row.
 *
 * (And a stored table **no entry names** is a *removal* — which is why this is a
 * tagged union rather than the obvious `id?: string`. With one optional field, a
 * draft row that had somehow acquired an id and a saved row that had lost one are
 * both representable, and each is a silent data-loss bug: the first mints a
 * duplicate table, the second deletes the row it meant to rename.)
 */
export type TournamentTableEntry =
  | { kind: 'kept'; table: TournamentTable }
  | { kind: 'added'; label: string; court: string }

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
  /** This tournament's **venue**, or `null` when it has none (CONTEXT.md, "Venue").
   *
   * `null` is a FIRST-CLASS state, not missing data, and it is reachable at every
   * status from draft to archived. It covers two situations that need no telling
   * apart, because nothing behaves differently: the venue is not booked yet, and the
   * venue is deliberately withheld — a small tournament at somebody's home, whose
   * address should not be pinned on a public map.
   *
   * ⚠️ **A tournament with no venue renders NOTHING** — no venue line, no pin, no
   * map, and emphatically never a "Venue TBD" placeholder. That copy promises a
   * venue is coming, which is false for the withheld case, and for a home game it
   * implies the address is merely missing rather than private. `fmtVenueLine`
   * (`./helpers`) takes the `null` and answers `''`, which is every caller's cue to
   * render no row at all.
   *
   * It is also never a proximity-search result: a venue-less tournament is dropped
   * from a near-me list at any radius, on the server and in the mock alike. */
  address: Address | null
  tableIds: string[]
  events: TournamentEvent[]
  /** The latest run of the schedule solver — the ledger row the Schedule tab's
   * solve strip renders — or `null` when no solve has ever been requested (the
   * designed "no solve yet" state, the one every tournament is born in). Parsed at
   * the boundary by `./solve`; read it, never write it — a new row appears only
   * through `POST …/schedule/solves` (or the server's own triggers). */
  latestScheduleSolve: ScheduleSolve | null
  /** The draw formats this server can actually run, in the order it wants them
   * offered — the `draw_types` catalogue off the tournament-detail payload (ADR
   * 20260726). It is what the event editor's draw-type picker renders and what every
   * surface that shows a *stored* draw type resolves its label through; the client
   * keeps no list of its own.
   *
   * **`null` means the payload did not carry one** — the LIST route withholds it, since
   * a catalogue is page data for the one page that picks a draw type — and it is
   * likewise `null` on a client-built draft that has never been fetched
   * (`emptyTournament`). It is NOT "the server offers nothing": a detail payload always
   * carries at least the two seeded rows. Parsed at the boundary by `./draw-types`. */
  drawTypes: DrawTypeOption[] | null
  /** How far this tournament's venue is from the point the list query was given a
   * location for — a non-negative haversine distance in **miles** — or `null` when the
   * query sent no location (the default list, and the detail payload). The server
   * computes it (`distance_miles`) and this client only reads it, parsed at the boundary
   * by `./api`. Optional because the tournaments the app builds from seeds/drafts carry
   * no distance; a mapped API row always sets it (to `null` when no location was sent). */
  distanceMiles?: number | null
}
