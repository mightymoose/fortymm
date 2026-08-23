import type { APIResponse } from '@playwright/test'
import { findUserId, mintGuest, type Guest } from './match-api'

// Composed-stack API helpers for provisioning the **inert scaffolding** of a
// tournament directly against the real API (through nginx at `/api`), so a spec
// can drive the load-bearing lifecycle steps — entering, cutting the draw, going
// live, recording the result, reading the standings — through the browser
// instead. Mirrors `match-api.ts`: writes ride the double-submit CSRF defense
// (`app/main.py`), echoing the guest's `csrf_token` cookie back in the
// `x-csrf-token` header.
//
// What is seeded here is everything a tournament needs to *exist* but that has no
// interesting UI of its own: the tournament, one singles round-robin event, its
// single reservation with a table, and (see `enterPlayer`) the second entrant, added
// by director-entry — for which there is deliberately no web UI today (the entry
// card only self-registers the signed-in player). The director's own entry is
// left for the browser to make through the Enter control.
//
// Everything created here is created **as the director** (the caller's own guest
// context), so the tournament comes back with `can_edit: true` and the browser,
// signed in as that same guest, sees the owner-only controls (Publish, Generate
// draw, Start tournament).
//
// **Two faces, one seed.** One term used to name both the competitive unit (an
// ordered set of entrants who play all-play-all) and the venue booking (a slice of
// tables held for a window of time). They are two arrays on the wire now — a
// **group** (`groups[]`: server-owned identity and order, read-only) and a
// **reservation** (`reservations[]`: the venue side, client-writable) — mapped 1:1.
// A client can only ever *write* a reservation; the server mints exactly one group
// per reservation in lockstep. So every spec-facing "seed N of them" knob here is
// reservation-shaped (`ReservationSpec`), and what comes back carries both:
// `StoredReservation` (what was written, plus the id and position the server
// stamped) and `StoredGroup` (the group the server minted for it, plus the
// `reservation_id` it maps to). A fixture's own `group_id` and everything the draw
// renders (entrants, standings, qualification) are group-face; a reservation's
// name, window and tables are venue-face.

const API = '/api/v1'
const CSRF_HEADER = 'x-csrf-token'

/** The **label** of the one table seeded into the tournament's catalogue, reserved by
 * the event's single reservation. A round-robin reservation wants at least one table.
 *
 * A label, not an id, because the id is no longer the seed's to choose (see
 * `TableSpec`). */
const TABLE_LABEL = 'Table 1'
/** The **name** of the event's single reservation — a round-robin needs ≥1
 * reservation (and therefore ≥1 group), and two entrants in one group is exactly
 * one fixture: the minimal playable draw.
 *
 * A name, not an id, for the same reason `TABLE_LABEL` is a label: the id is no
 * longer the seed's to choose (see `ReservationSpec`). */
const RESERVATION_NAME = 'Reservation A'

/** A reservation/event window (`Slot` on the wire): a date plus `HH:MM` bounds, all
 * naive wall-clock strings in the venue's frame (ADR-0790). */
export interface SlotSpec {
  readonly date: string
  readonly start: string
  readonly end: string
}

/** Tomorrow, `YYYY-MM-DD`, UTC — the date a seeded window sits on. The default
 * reservation window uses it, and so does any spec that builds its own `SlotSpec`,
 * so the rule lives here once.
 *
 * **Computed, never a literal.** This used to be the string `'2026-08-01'`, which
 * was comfortably far-future when it was written and then arrived: from 17:00 UTC
 * that day every seeded window was in the *past*, and from the next day it was
 * permanently so. The schedule preview solves fixtures into their reservation's
 * window, and a window behind `now` admits no placement — so the solve is honestly
 * infeasible and the verdict reads `Doesn't fit · peak 0 tables`. The solver was
 * right; the fixture had expired.
 *
 * It is a poor bug to inherit: the message points at *tables*, the failure is
 * total rather than flaky, and it reds every branch at once, so it reads like
 * whatever change happens to be in flight. Tomorrow keeps the window genuinely
 * ahead of any run, at any hour, forever.
 *
 * UTC because the compose stack's clock is UTC and `seedTournament` anchors its
 * events to `timezone: 'UTC'` — the date and the frame have to agree, or the
 * window drifts by a day either side of midnight. */
export function tomorrowUtc(): string {
  const DAY_MS = 24 * 60 * 60 * 1000
  return new Date(Date.now() + DAY_MS).toISOString().slice(0, 10)
}

/** One table of the tournament's catalogue, as a client **sends** it
 * (`TournamentTableWrite` on the wire): what it is called and where it stands, and
 * deliberately **no id**.
 *
 * A table is a row now, and its id is minted by the database (ADR 20260801, "a
 * placement names a real table, and only that is an invariant"). The write shape has no
 * `id` field at all and is `extra="forbid"`, so a seed that supplies its own `t1` is a
 * **422 naming the field**, not a stack that agrees to call the table `t1` — which is
 * exactly how this helper broke when the catalogue became a real table.
 *
 * So nothing here names a table by id. A reservation cites the tables it books by
 * **label** (`ReservationSpec.tableLabels`), and anything that needs the real id reads
 * it back off the create response (`StoredTable`, returned by `createTournament` and
 * `seedTournament`). The label is also the vocabulary the server's own in-use refusal
 * speaks, so a spec asserting on that sentence and a spec seeding the catalogue name
 * the same table the same way. */
export interface TableSpec {
  readonly label: string
  readonly court: string
}

/** One table as the API **reads it back** (`TournamentTable` on the wire): what was
 * sent, plus the uuid the server minted for it.
 *
 * The only place a spec can learn a table id — and the id everything downstream is
 * keyed by: a fixture's `table_id`, the schedule board's table sections, a
 * reservation's `table_ids`. */
export interface StoredTable {
  readonly id: string
  readonly label: string
  readonly court: string
}

/** One reservation of the event's draw, as a **client sends it** (`ReservationWrite`
 * on the wire): what it is called and which tables it books, and deliberately
 * **neither an `id` nor a `position`**.
 *
 * Both absences are the wire's, not this helper's taste. `ReservationWrite` is
 * `extra="forbid"` and has no field for either, so a seed supplying its own
 * `reservation-a` is a **422 naming `body.reservations[i].id`** — which is exactly how
 * this helper broke when a reservation became a real row with a
 * `gen_random_uuid()` primary key (ADR 20260801). The id is the database's now,
 * the same as a catalogue table's.
 *
 * So nothing here names a reservation by id:
 *
 * - a reservation is written down by **name**, the label a director types and
 *   what a spec's venue-facing assertions read;
 * - a reservation cites the tables it books by **label** (`tableLabels`), resolved
 *   against the catalogue `seedTournament` just created — the ids are minted too;
 * - anything that needs the real reservation id reads it back off the create
 *   response (`StoredReservation`, returned by `seedTournament`).
 *
 * The **order of `SeedTournamentOptions.reservations`** is therefore the payload's
 * one statement about draw order: the server stamps each reservation's `position`
 * from its index in the list it was sent (ADR 20260801, "reservations carry an
 * explicit `position`"), mints exactly one **group** per reservation in the same
 * order, and that group order is what the draw, the deal and the rendered group
 * sections are all ordered by (`StoredGroup`).
 *
 * `tableLabels` is optional because the single-reservation default books the whole
 * catalogue; a multi-reservation seed usually wants a table each, so ten
 * reservations raise no double-booking warning over one shared table.
 *
 * `tableIdsFor` throws on a label that names no seeded table rather than sending a
 * reservation the solver would quietly intersect away to nothing. */
export interface ReservationSpec {
  readonly name: string
  /** The catalogue tables this reservation books, **by label**. Omitted = **every**
   * seeded table. */
  readonly tableLabels?: ReadonlyArray<string>
}

/** One reservation as the API **reads it back** (`Reservation` on the wire): what
 * was sent, plus the uuid the server minted for it and the 0-based `position` it
 * stamped from the reservation's index in the list it arrived in (ADR 20260801).
 *
 * The only place a spec can learn a reservation id — the id a future PATCH would
 * cite to keep this row. Only the three fields an ordering assertion is about are
 * named; the window and tables ride along untyped. **Not** the id everything
 * downstream is keyed by — a fixture, the draw's sections and the standings table
 * are all keyed by the **group's** id (`StoredGroup`), never this one. */
export interface StoredReservation {
  readonly id: string
  readonly name: string
  readonly position: number
}

/** One **group** the server minted for a reservation, as the API reads it back
 * (`GroupRead` on the wire): server-owned identity and order, plus which
 * reservation it plays under.
 *
 * A group has no write shape — a client never authors one directly; the server
 * mints exactly one per reservation, in lockstep, from `EventReservations` /
 * `EditedEventReservations` (ADR 20260801, extended). `reservation_id` is the
 * join back to `StoredReservation.id`, kept in the wire's own snake case because
 * this interface types a direct JSON parse of the create/read response, the same
 * convention `FixtureDetail` below uses for its own `*_id` fields.
 *
 * The id everything competitive is keyed by: a fixture's `group_id`, the draw's
 * group sections, the `group-standings-{id}` table. */
export interface StoredGroup {
  readonly id: string
  readonly position: number
  /** Which of this event's stages the group belongs to (ADR 20260823, #1484). Every
   * stage now holds its own group rows, so `position` is unique only WITHIN one
   * stage — an `rr-then-ko` event's knockout stage holds a group at `position: 0`
   * too, sharing that number with the group stage's own first group. A caller that
   * needs "the event's group-stage groups in order" must filter to one `stage_id`
   * first (see `tournament-rr-then-ko.spec.ts`). */
  readonly stage_id: string
  /** The reservation this group plays in, or `null` for a group that plays in none
   * (#1387) — the state a **reservation-less** event's one group is always in, since
   * #1483's floor mints a group whatever the reservation count. Its fixtures then fall
   * to the synthetic event-wide reservation (the event's own slot over the whole
   * catalogue) until #1364 mints one for them. */
  readonly reservation_id: string | null
}

/** `Group A`, `Group B`, … and past `Group Z` the spreadsheet's `AA` — a bijective
 * base-26 label, so a hundred-group field names its groups instead of printing
 * punctuation.
 *
 * The e2e-side mirror of the server's `app.draws.group_letter`/`group_label` (ADR
 * 20260808, "draw-structure derivation runs on both sides and shares its vectors"):
 * once a group carries no director-typed name of its own, its rendered label is
 * *computed* from `position`, so a spec asserting on what the draw shows has to
 * compute the same label rather than assume the director's seed order reads back
 * as its own names. `position` is 0-based. */
export function groupLetter(position: number): string {
  let letters = ''
  for (let n = position; n >= 0; n = Math.floor(n / 26) - 1) {
    letters = String.fromCharCode(65 + (n % 26)) + letters
  }
  return letters
}

/** `Group {letter}` — the full label a group renders as, everywhere the app used to
 * print a stored reservation name. */
export function groupLabel(position: number): string {
  return `Group ${groupLetter(position)}`
}

/** A venue's six free-text address components (`AddressInput` on the wire). The
 * server geocodes these to coordinates at write time via the injected
 * `Geocoder` — the e2e compose stack declares `GEOCODER: fake`
 * (`docker-compose.e2e.yml`), so that is the deterministic, network-free
 * `FakeGeocoder`, which maps the composed address string to stable coords by
 * SHA-256. The choice is explicit config, not inferred from the absence of a
 * `GOOGLE_GEOCODING_API_KEY`, so adding a key to the stack does not quietly put
 * these helpers on live Google results. Two *different* addresses
 * therefore geocode to two different, stable points — which is exactly what the
 * near-me filter spec needs to place a venue at a known distance from another. */
export interface AddressInput {
  readonly venue: string
  readonly street: string
  readonly city: string
  readonly region: string
  readonly postal: string
  readonly country: string
}

/** A venue's stored coordinates as geocoded server-side and read back off the
 * tournament's `address` value-object — both NOT NULL *within* an address.
 *
 * The outer invariant is weaker than the coordinates one: a tournament may carry
 * **no address at all** (`address: null`), so the thing that can be missing is the
 * whole venue, never one half of a located one. See the 2026-07-26 amendment to
 * docs/adr/20260725-a-venues-coordinates-are-geocoded-server-side-and-not-null.md. */
export interface Coords {
  readonly latitude: number
  readonly longitude: number
}

/** A tournament's stored venue as the detail read carries it: the six free-text
 * components the organizer typed plus the coordinates the server geocoded them to.
 * Only `venue` is named here beyond the coordinates — it is the one component a
 * spec asserts on; the rest ride along untyped because no spec reads them. */
export interface StoredAddress extends Coords {
  readonly venue: string
}

/** The draw types this seed can author.
 *
 * `round-robin` and `single-elim` carry no draw settings at all (their arms of the
 * server's union are the empty object — a bracket has no groups to qualify out of and
 * its depth is derived from the field), so seeding them is one key on the wire.
 *
 * `rr-then-ko` carries **K** (`qualifiers_per_group`), required with no default on its
 * arm, so seeding it means sending `SeedEventOptions.qualifiersPerGroup` too — the
 * option says what happens when you don't.
 *
 * ⚠️ **`swiss` is still deliberately absent, and `rr-then-ko`'s CREATE PAYLOAD is still
 * the browser's job.** The payload the event editor builds (`drawSettingsToApi`) is the
 * seam the arc's 422 lived in — the client named `rr-then-ko` and sent no K — and no
 * mocked suite can see it. `tournament-rr-then-ko.spec.ts` and `tournament-swiss.spec.ts`
 * therefore author their event **through the sheet**, and must go on doing so: this
 * option exists for the specs whose subject is the **read** path (what the server sends
 * back and the client renders from it), not the write one. Seeding an rr-then-ko event
 * here to test the create would prove only that the server accepts a body the test itself
 * composed. */
export type SeededDrawType = 'round-robin' | 'single-elim' | 'rr-then-ko'

/** Optional knobs on `addEvent` — one event of an existing tournament.
 *
 * Every knob is also a `seedTournament` knob, because `seedTournament` is
 * "`createTournament` + one `addEvent`". The one field only this interface carries is
 * `name`: a tournament's name is `seedTournament`'s own positional argument, and its
 * one event has always been called `Open Singles`. A caller adding a **second** event
 * has to be able to tell the two apart — the preview's honest notes, its synthetic-field
 * line and its per-event override boxes all name an event by name, so a spec that reads
 * them needs two names it chose itself. */
export interface SeedEventOptions {
  /** The event's name. Omitted = `Open Singles`, the name every existing spec's single
   * event carries and asserts on. */
  readonly name?: string
  /** The event's draw type. Omitted = `round-robin`, the original minimal shape.
   *
   * `single-elim` is what `tournament-single-elim-schedule.spec.ts` seeds, and it is
   * seeded **with `reservations: []`** — which no longer means the bracket is
   * un-grouped. Since #1483 a single-elim or swiss stage holds one group whatever the
   * reservation count, and every fixture of its draw is dealt into it, so the bracket
   * is confined to whatever that group maps to. Booking nothing is what keeps this
   * seed's group mapped to no reservation, and its fixtures therefore falling to the
   * synthetic event-wide reservation — the event's own slot over the whole catalogue
   * (ADR 20260807, "a group restricts scheduling, it does not enable it"), which is
   * still the spec's subject. #1364 closes that fallback by minting a reservation, and
   * rewrites the spec's assertions when it does. */
  readonly drawType?: SeededDrawType
  /** **K** — how many finishers of each group reach the knockout. Sent only when given,
   * because the key is a **422 naming itself** on every arm but `rr-then-ko`: the union's
   * arms are `extra="forbid"`, and a qualifier count on a format with no knockout stage is
   * refused at the request boundary rather than dropped.
   *
   * Required *with* `drawType: 'rr-then-ko'`, and required in the other direction too —
   * that arm has no default. Omitting it there is the same 422, naming the field. */
  readonly qualifiersPerGroup?: number
  /** The window both the event and its reservations carry. Omitted = tomorrow,
   * 09:00–17:00. */
  readonly slot?: SlotSpec
  /** The event's reservations, **in the director's order** — see
   * `SeedTournamentOptions.reservations`, which is this same option. */
  readonly reservations?: ReadonlyArray<ReservationSpec>
  /** The event's `max_players` cap. Omitted = uncapped — see
   * `SeedTournamentOptions.maxPlayers`. */
  readonly maxPlayers?: number
}

/** One event as `addEvent` reads it back: the uuid the server minted for it, its
 * reservations **as stored** (empty for an event seeded with `reservations: []`), and
 * the groups the server minted **one per reservation — but never fewer than one**
 * (#1483's floor). An event that books nothing therefore reads back no reservations and
 * exactly one group, whose `reservation_id` is `null`. */
export interface SeededEvent {
  readonly eventId: string
  readonly reservations: ReadonlyArray<StoredReservation>
  readonly groups: ReadonlyArray<StoredGroup>
}

/** Optional knobs on `seedTournament`. Defaults reproduce the original minimal
 * shape (one round-robin, one table, one reservation, a far-future window), so
 * existing specs are untouched; the solver-schedule spec overrides two of them — its
 * reservation window must bracket the stack's real NOW for the call-ahead pinning to
 * fire naturally, and a 4-entrant round-robin wants two tables to run its rounds in
 * parallel. */
export interface SeedTournamentOptions {
  /** The event's draw type. Omitted = `round-robin`, the original minimal shape.
   *
   * `single-elim` is what `tournament-single-elim-schedule.spec.ts` seeds, and it is
   * seeded **with `reservations: []`** — which no longer means the bracket is
   * un-grouped. Since #1483 a single-elim or swiss stage holds one group whatever the
   * reservation count, and every fixture of its draw is dealt into it, so the bracket
   * is confined to whatever that group maps to. Booking nothing is what keeps this
   * seed's group mapped to no reservation, and its fixtures therefore falling to the
   * synthetic event-wide reservation — the event's own slot over the whole catalogue
   * (ADR 20260807, "a group restricts scheduling, it does not enable it"), which is
   * still the spec's subject. #1364 closes that fallback by minting a reservation, and
   * rewrites the spec's assertions when it does. */
  readonly drawType?: SeededDrawType
  /** **K** — see `SeedEventOptions.qualifiersPerGroup`, which is this same option on
   * the one event `seedTournament` adds. */
  readonly qualifiersPerGroup?: number
  /** The window both the event and its single reservation carry. */
  readonly slot?: SlotSpec
  /** The table catalogue; the reservation books every listed table. */
  readonly tables?: ReadonlyArray<TableSpec>
  /** The event's reservations, **in the director's order** — omitted = the original
   * single `Reservation A` over the whole catalogue, so existing specs are untouched.
   * **`[]` seeds an event that books nothing**: the create verb takes any number of
   * reservations, zero included, and `??` leaves an explicit empty list alone (only an
   * *omitted* option falls back to the default). It no longer means "no groups" —
   * #1483's floor mints one anyway, mapped to no reservation, and the event's fixtures
   * fall to the synthetic event-wide reservation through it.
   *
   * The list's order is the whole point of the option: it is what the server turns into
   * the stored `position`s — of the reservations themselves, and of the groups it mints
   * for them in lockstep — and therefore what the draw, the deal and the rendered group
   * sections are all ordered by. A caller seeding several reservations is making a
   * statement about their (and their groups') order whether it means to or not. */
  readonly reservations?: ReadonlyArray<ReservationSpec>
  /** The event's `max_players` cap. Omitted = uncapped (the original minimal
   * shape). The schedule-preview spec sets a small cap so the synthetic field a
   * preview auto-fills to (an uncapped event defaults to 16) is small enough that
   * the real solver returns a fast, clean "fits" verdict rather than an
   * over-the-cap `unknown`. */
  readonly maxPlayers?: number
  /** The venue address the server geocodes to the tournament's coordinates.
   *
   * Omitted defaults to a single fixed address (so existing specs are untouched);
   * the near-me spec passes two *distinct* addresses so the two tournaments land
   * at two different, stable `FakeGeocoder` points.
   *
   * **`null` seeds a tournament with NO VENUE** — a first-class state (CONTEXT.md,
   * "Venue"): announced before the room is booked, or deliberately withheld. It
   * sends the create payload with the `address` key **absent**, which is what a
   * non-browser caller does; the browser's own route to the same state is an
   * explicit `address: null` from a form whose six venue boxes are all blank, and
   * `tournament-no-venue.spec.ts` drives that one through the UI. Both land on the
   * same SQL NULL, which is the single representation of "no venue". */
  readonly address?: AddressInput | null
}

/** A created tournament and the catalogue the server minted for it. */
export interface CreatedTournament {
  readonly tournamentId: string
  /** The seeded tables **as stored**, in the order they were sent — each now carrying
   * the uuid the server minted. The only handle a caller has on a table id. */
  readonly tables: ReadonlyArray<StoredTable>
}

/** A seeded tournament and the ids a spec needs to address it and its event. */
export interface SeededTournament extends CreatedTournament {
  readonly eventId: string
  /** The event's reservations **as stored** — read off the create response, so each
   * carries the uuid the server minted and the `position` it stamped, in the order they
   * were sent. The only handle a spec has on a reservation id — what a future PATCH
   * would cite to keep the row. */
  readonly reservations: ReadonlyArray<StoredReservation>
  /** The groups the server minted, from EVERY stage the event holds (ADR 20260823,
   * #1484) — a non-composite draw type's own single stage's groups (one per
   * reservation, but never fewer than one, #1483's floor), or, for `rr-then-ko`, its
   * group stage's derived groups AND its knockout stage's own one, mixed together.
   * A seed that books nothing therefore still reads back a group whose
   * `reservation_id` is `null`. Filter on `stage_id` before reading `position` as an
   * order — see `getEventStages`. The id everything competitive is keyed by — a
   * fixture's `group_id`, the draw's group sections, a standings table. */
  readonly groups: ReadonlyArray<StoredGroup>
  /** The event's **first** group id — its only one under the default seed — so a spec
   * can scope its standings assertions without indexing `groups` itself.
   *
   * Non-null for every event the API can now create, since the floor above mints a
   * group whatever the reservation count. Kept nullable all the same: it is read off
   * `groups[0]`, and a type that says "there is always a first element" of a list this
   * module does not control is a claim about the server that belongs in an assertion,
   * not in a type. That nullability is what stops an `undefined` travelling into a
   * locator and resolving nothing. */
  readonly groupId: string | null
}

/**
 * Create a **draft** tournament and nothing else — no events.
 *
 * The empty shell is a first-class seed, not half of `seedTournament`: an event is the
 * subject of some specs rather than their scaffolding. `tournament-rr-then-ko.spec.ts`
 * authors its event through the **event editor in the browser**, because the payload
 * that editor builds — specifically whether it carries `qualifiers_per_group` — is the
 * exact seam the arc's 422 lived in, and an event seeded here by hand-written JSON
 * would prove only that the *server* accepts the field.
 *
 * The table catalogue is still seeded (a reservation references its tables by id, and
 * the browser has no way to invent one), as is the venue — see `SeedTournamentOptions`
 * for what `address: null` means.
 */
export async function createTournament(
  director: Guest,
  name: string,
  options: SeedTournamentOptions = {},
): Promise<CreatedTournament> {
  const tables = options.tables ?? [{ label: TABLE_LABEL, court: 'A' }]
  // `??` would be wrong here: `null` is a MEANINGFUL value for this option ("no
  // venue"), and `null ?? default` would silently give it a venue. Only an
  // *omitted* option falls back to the default address.
  const address =
    options.address === undefined
      ? {
          venue: 'Test Arena',
          street: '1 Test Way',
          city: 'Testville',
          region: 'TS',
          postal: '00000',
          country: 'Testland',
        }
      : options.address

  const res = await director.ctx.post(`${API}/tournaments`, {
    headers: { [CSRF_HEADER]: director.csrf },
    data: {
      name,
      // No venue = the `address` key is simply absent from the payload. Sending
      // it as `null` would work too (both mean "no venue" on create), but the
      // absent key is the shape a non-browser caller produces, and keeping the
      // two routes distinct is deliberate: the browser's explicit `null` is
      // covered through the UI in `tournament-no-venue.spec.ts`.
      ...(address === null ? {} : { address }),
      // A reservation references these tables by id, so the catalogue must carry
      // them — sent WITHOUT ids (see `TableSpec`), and read back below with the
      // ones the server minted.
      table_catalogue: tables.map((table) => ({
        label: table.label,
        court: table.court,
      })),
    },
  })
  if (res.status() !== 201) {
    throw new Error(`create tournament failed: ${res.status()} ${await res.text()}`)
  }
  // `TournamentRead` carries the stored catalogue, in the order it was sent — so the
  // minted ids come back on the create itself and no second read is needed to learn
  // them.
  const created = (await res.json()) as {
    id: string
    table_catalogue: ReadonlyArray<StoredTable>
  }
  return { tournamentId: created.id, tables: created.table_catalogue }
}

/**
 * Create a **draft** tournament with one singles, **round-robin**, **unrated**,
 * best-of-1 event, drawn across a single group that plays under one reservation
 * holding one table — the minimal shape that can go live and produce a champion.
 * `options.reservations` seeds several instead, in the order given (see
 * `ReservationSpec`).
 *
 * `rated: false` + `length_games: 1` is load-bearing, not incidental: an unrated
 * tournament match takes the immediate self-accept completion path, so recording
 * its result COMPLETES it with no second party accepting — one browser session
 * can drive the whole thing. `max_players` is left uncapped (omitted): the spec
 * enters exactly two, and a cap only adds a way to fail.
 *
 * Two API calls, both as the director: `createTournament` then one `addEvent`. A
 * tournament that needs a **second** event calls `addEvent` again itself, with the
 * catalogue this returned. The lifecycle (publish → cut → go live) and the entries are
 * the browser's job.
 */
export async function seedTournament(
  director: Guest,
  name: string,
  options: SeedTournamentOptions = {},
): Promise<SeededTournament> {
  const tables = options.tables ?? [{ label: TABLE_LABEL, court: 'A' }]
  // Resolve the catalogue HERE and pass it down, rather than letting
  // `createTournament` default it again: the event's reservations book tables out of
  // the catalogue it creates, so the two must be the same list by construction. What
  // comes back (`storedTables`) is that same list carrying the ids the server minted —
  // the only form in which a reservation can name a table on the wire.
  const { tournamentId, tables: storedTables } = await createTournament(
    director,
    name,
    { ...options, tables },
  )

  // The options are forwarded ONE BY ONE rather than spread. `SeedTournamentOptions`
  // also carries `tables` and `address`, which are the *tournament's*, and a spread
  // would hand them to an event that has no such fields. `reservations` in particular
  // must travel as-is: an explicit `[]` is "this event has NO reservations (and mints
  // no groups)", and only an *omitted* option may fall back to the single
  // `Reservation A`.
  const { eventId, reservations, groups } = await addEvent(
    director,
    tournamentId,
    storedTables,
    {
      drawType: options.drawType,
      qualifiersPerGroup: options.qualifiersPerGroup,
      slot: options.slot,
      reservations: options.reservations,
      maxPlayers: options.maxPlayers,
    },
  )

  return {
    tournamentId,
    tables: storedTables,
    eventId,
    reservations,
    groups,
    groupId: groups[0]?.id ?? null,
  }
}

/**
 * Add **one event** to an existing tournament (`POST …/events`), against a catalogue
 * that already exists — the seam `seedTournament` is built out of, exported so a spec
 * can seed a tournament holding **more than one** event.
 *
 * The multi-event seed is not a convenience: some behaviour only exists between events.
 * `schedule-preview-mixed-draw.spec.ts` needs a round-robin event standing beside a
 * single-elimination one, because the fact under test is that the unpreviewable event is
 * skipped **and the other one is still previewed** — which a one-event tournament cannot
 * express either way.
 *
 * `catalogue` is the tournament's stored tables (from `createTournament` or
 * `seedTournament`), because a reservation names the tables it books by catalogue
 * **id** and a caller only holds labels — see `ReservationSpec`.
 */
export async function addEvent(
  director: Guest,
  tournamentId: string,
  catalogue: ReadonlyArray<StoredTable>,
  options: SeedEventOptions = {},
): Promise<SeededEvent> {
  const slot = options.slot ?? {
    date: tomorrowUtc(),
    start: '09:00',
    end: '17:00',
  }
  // `??`, never `||` or a truthiness test: `[]` is a MEANINGFUL value here ("this event
  // has no reservations, and therefore mints no groups", which is what an un-grouped
  // draw type wants), and a truthy check would quietly give it `Reservation A` back and
  // destroy the premise of any spec that asked for none.
  const reservations = options.reservations ?? [{ name: RESERVATION_NAME }]

  const eventRes = await director.ctx.post(
    `${API}/tournaments/${tournamentId}/events`,
    {
      headers: { [CSRF_HEADER]: director.csrf },
      data: {
        name: options.name ?? 'Open Singles',
        // The compose stack's clock is UTC, and the solver-schedule spec builds
        // its reservation window around the stack's real NOW; anchoring the event
        // to UTC keeps a naive wall-clock window resolving to the same instant it
        // did before events carried a venue timezone (ADR "tournament times are
        // timezone-aware instants"), so the window still brackets NOW.
        timezone: 'UTC',
        format: 'singles',
        // The caller's draw type, defaulting to the original round-robin.
        draw_type: options.drawType ?? 'round-robin',
        // **K**, beside the draw type it belongs to — the server parses the two as one
        // pair (ADR 20260727). Sent only when the caller gives it: the key is refused on
        // every other arm of the union (`extra="forbid"`), so an unconditional
        // `qualifiers_per_group: null` would 422 every round-robin this helper has ever
        // seeded.
        ...(options.qualifiersPerGroup !== undefined
          ? { qualifiers_per_group: options.qualifiersPerGroup }
          : {}),
        entry_fee: 0,
        // Only sent when the caller caps the field; omitting the key leaves the
        // event uncapped (the API treats a missing `max_players` as no cap).
        ...(options.maxPlayers !== undefined
          ? { max_players: options.maxPlayers }
          : {}),
        slot,
        match_settings: { rated: false, length_games: 1 },
        predicates: [],
        // Sent in the caller's order and NEVER re-sorted here: this array's order is
        // what `stored_groups` stamps the reservations' (and, in lockstep, the
        // groups') `position`s from, so re-ordering it — even "tidily", by name —
        // would silently seed a different event than the one the spec asked for. No
        // reservation carries an `id` or a `position` key either; sending either is a
        // 422 naming it (`ReservationWrite` is `extra="forbid"` and has neither
        // field).
        reservations: reservations.map((reservation) => ({
          name: reservation.name,
          slot,
          // Labels resolved to the ids the server just minted — a reservation's
          // `table_ids` are catalogue ids on the wire, and a stale one is silently
          // intersected away by the solver ("a stale ref is a table the reservation
          // cannot use"), so a typo would surface as an inexplicably infeasible day
          // rather than an error.
          table_ids: tableIdsFor(catalogue, reservation.tableLabels),
        })),
      },
    },
  )
  if (eventRes.status() !== 201) {
    throw new Error(
      `create event failed: ${eventRes.status()} ${await eventRes.text()}`,
    )
  }
  // `TournamentEventRead` carries the stored reservations AND the groups minted for
  // them, both ordered by the `position` the server just stamped (each relationship's
  // own `order_by`) — so the minted ids come back on the create itself, in the order
  // they were sent, and no second read is needed to learn them.
  const created = (await eventRes.json()) as {
    id: string
    reservations: ReadonlyArray<StoredReservation>
    groups: ReadonlyArray<StoredGroup>
  }
  if (created.reservations.length !== reservations.length) {
    throw new Error(
      `seeded ${reservations.length} reservations but the event stored ${created.reservations.length}`,
    )
  }
  // The server owns the groups (ticket #1387, ADR 20260822, ADR 20260823). Every
  // stage now holds its own group rows (#1484) — an `rr-then-ko` event's group stage
  // derives `ceil(field / 5)` of them from its preview field (the cap, or 16 when
  // uncapped), and its knockout stage holds exactly ONE more, always — and every
  // other draw type's one and only stage holds exactly one, decoupled from its
  // reservation count entirely (#1483's floor: a stage with no group row has no hop
  // for the solver to reach a reservation through, so an event that books nothing
  // still holds one group, mapped to none). A mismatch here means the server's rule
  // moved, which no caller of this helper could ever observe from the reservations
  // array alone.
  const expectedGroups =
    (options.drawType ?? 'round-robin') === 'rr-then-ko'
      ? Math.ceil((options.maxPlayers ?? 16) / 5) + 1
      : 1
  if (created.groups.length !== expectedGroups) {
    throw new Error(
      `expected the event to mint ${expectedGroups} groups but it minted ${created.groups.length}`,
    )
  }

  return { eventId: created.id, reservations: created.reservations, groups: created.groups }
}

/** Resolve a reservation's booked-table **labels** to the catalogue ids the wire
 * wants; omitted labels book the whole catalogue (the single-reservation default).
 *
 * Throws on a label the catalogue does not hold. That is not defensiveness for its own
 * sake: an unresolvable label sent as-is would be a table the reservation "books" and
 * the solver cannot see, so the seed would look fine and the day would come back
 * infeasible three screens away. */
function tableIdsFor(
  tables: ReadonlyArray<StoredTable>,
  labels: ReadonlyArray<string> | undefined,
): string[] {
  if (labels === undefined) return tables.map((table) => table.id)
  return labels.map((label) => {
    const table = tables.find((candidate) => candidate.label === label)
    if (!table) {
      const known = tables.map((t) => t.label).join(', ') || '(none)'
      throw new Error(
        `reservation books "${label}", which the seeded catalogue does not hold — has: ${known}`,
      )
    }
    return table.id
  })
}

/**
 * Enter `userId` into the event as the tournament's **director** (ADR-0784):
 * `POST …/entries` with a `{ user_id }` body, which only the owner may send.
 *
 * This is how the second entrant gets in without a web UI — the entry card only
 * self-registers the signed-in player, so director-entry has no browser surface
 * to drive. Requires the tournament to be **published** (registration open), so
 * the caller publishes first.
 */
export async function enterPlayer(
  director: Guest,
  tournamentId: string,
  eventId: string,
  userId: string,
): Promise<void> {
  const res = await director.ctx.post(
    `${API}/tournaments/${tournamentId}/events/${eventId}/entries`,
    {
      headers: { [CSRF_HEADER]: director.csrf },
      data: { user_id: userId },
    },
  )
  if (res.status() !== 201) {
    throw new Error(
      `director-entry failed: ${res.status()} ${await res.text()}`,
    )
  }
}

/** The slice of an event the rr-then-ko spec reads back off the tournament detail:
 * its id, and the **draw configuration as the server stored it**.
 *
 * `draw_type` and `qualifiers_per_group` are one fact in two columns (ADR 20260727), so
 * they are read as a pair. Reading them back is what turns "the create request did not
 * 422" into "the server holds the configuration the director typed" — a 201 alone would
 * also be returned by a server that had quietly dropped K. */
export interface EventDrawConfig {
  readonly id: string
  readonly name: string
  readonly draw_type: string
  /** **K**. `null` for every draw type that has no knockout stage to qualify for. */
  readonly qualifiers_per_group: number | null
  /** **R** — how many rounds a `swiss` event plays. `null` for every other draw type,
   * which does not ask the question (a round-robin's rounds fall out of the circle
   * method, a bracket's depth out of the field).
   *
   * Read back for the reason `qualifiers_per_group` is: it is **required with no
   * default** on the swiss arm of the server's draw-settings union, so it is the field
   * a create body is refused for omitting — and a 201 alone would also come back from
   * a server that accepted the body and dropped R on the floor. */
  readonly rounds: number | null
  /** The server's own count of active entries. Read here rather than counted off the
   * roster on screen, which **truncates** at eight chips and a `+N more` line: a spec
   * counting list items there would be counting the truncation, and at nine entrants
   * the two numbers happen to coincide — a green assertion measuring the wrong thing. */
  readonly entered: number
}

/**
 * Find an event of `tournamentId` **by name** and return its id and draw configuration.
 *
 * By name because the spec that needs this created the event *in the browser* — the id
 * was minted server-side and never crossed back through anything the test can see. The
 * name is the one handle the test authored itself.
 *
 * Throws when no event matches, which is the honest report of a create that silently
 * did not happen.
 */
export async function findEventByName(
  viewer: Guest,
  tournamentId: string,
  eventName: string,
): Promise<EventDrawConfig> {
  const res = await viewer.ctx.get(`${API}/tournaments/${tournamentId}`)
  if (!res.ok()) {
    throw new Error(`load tournament failed: ${res.status()} ${await res.text()}`)
  }
  const detail = (await res.json()) as {
    events: ReadonlyArray<EventDrawConfig>
  }
  const event = detail.events.find((e) => e.name === eventName)
  if (!event) {
    const names = detail.events.map((e) => e.name).join(', ') || '(none)'
    throw new Error(
      `no event named "${eventName}" on tournament ${tournamentId} — has: ${names}`,
    )
  }
  return event
}

/** One row of the served **draw-type catalogue** (`DrawTypeRead` on the wire): the slug
 * an event stores, and the director-facing copy for it.
 *
 * The copy is **seed data** — a `draw_types` row a migration inserts — and the tournament
 * detail carries the whole catalogue so a picker renders what it was sent rather than a
 * list of its own (ADR 20260726). So this is the one seam that can say the copy exists at
 * all: the client's own parser keeps only `key`/`name`/`display_order`, so `description`
 * reaches no surface a browser assertion could read. */
export interface DrawTypeRow {
  readonly key: string
  readonly name: string
  readonly description: string
}

/**
 * Read the **served draw-type catalogue** off a tournament's detail payload.
 *
 * Throws when the payload carries none. `draw_type_catalogue` is nullable on the wire —
 * the LIST route withholds it, since it is page data for the one page that picks a draw
 * type — and a caller asking for it has a detail read in hand, so a `null` here means the
 * shape changed rather than "this tournament offers no formats".
 */
export async function getDrawTypeCatalogue(
  viewer: Guest,
  tournamentId: string,
): Promise<ReadonlyArray<DrawTypeRow>> {
  const res = await viewer.ctx.get(`${API}/tournaments/${tournamentId}`)
  if (!res.ok()) {
    throw new Error(`load tournament failed: ${res.status()} ${await res.text()}`)
  }
  const detail = (await res.json()) as {
    draw_type_catalogue: ReadonlyArray<DrawTypeRow> | null
  }
  if (detail.draw_type_catalogue === null) {
    throw new Error(
      `tournament ${tournamentId} came back with NO draw-type catalogue — the detail read carries one`,
    )
  }
  return detail.draw_type_catalogue
}

/**
 * Read an event's reservations back off the tournament detail, **as stored**.
 *
 * This is the one seam that can say whether the server took the order the director sent
 * and made it a fact: a client cannot send a `position` at all (`ReservationWrite` is
 * `extra="forbid"` — it is a 422), so every position on the wire was assigned here. A
 * spec that only read the rendered page could not tell "the server ordered them" from
 * "the client re-derived an order that happened to agree".
 *
 * The reservations are returned **exactly as the payload carries them**, unsorted, so a
 * caller asserting on the order is asserting on the server's, not on this helper's.
 */
export async function getEventReservations(
  viewer: Guest,
  tournamentId: string,
  eventId: string,
): Promise<ReadonlyArray<StoredReservation>> {
  const res = await viewer.ctx.get(`${API}/tournaments/${tournamentId}`)
  if (!res.ok()) {
    throw new Error(`load tournament failed: ${res.status()} ${await res.text()}`)
  }
  const detail = (await res.json()) as {
    events: ReadonlyArray<{ id: string; reservations: ReadonlyArray<StoredReservation> }>
  }
  const event = detail.events.find((e) => e.id === eventId)
  if (!event) {
    throw new Error(`no event ${eventId} on tournament ${tournamentId}`)
  }
  return event.reservations
}

/**
 * Read an event's **groups** back off the tournament detail, **as stored** — the
 * competitive-face twin of `getEventReservations`.
 *
 * A group is never client-written, so there is no "did the server take the order"
 * question here the way there is for reservations — the server mints every stage's
 * group rows from its own template entry (ADR 20260823, #1484), and stamps each
 * group's `position` from its own stage's list index. **Every stage now**, not just
 * the group stage: an `rr-then-ko` event's knockout stage has a group too, so this
 * returns groups from BOTH stages, mixed together — filter on `stage_id` before
 * reading `position` as an order. What a caller *can* only learn here is the id
 * everything competitive is keyed by: a fixture's `group_id`, the draw's group
 * sections, a standings table.
 */
export async function getEventGroups(
  viewer: Guest,
  tournamentId: string,
  eventId: string,
): Promise<ReadonlyArray<StoredGroup>> {
  const res = await viewer.ctx.get(`${API}/tournaments/${tournamentId}`)
  if (!res.ok()) {
    throw new Error(`load tournament failed: ${res.status()} ${await res.text()}`)
  }
  const detail = (await res.json()) as {
    events: ReadonlyArray<{ id: string; groups: ReadonlyArray<StoredGroup> }>
  }
  const event = detail.events.find((e) => e.id === eventId)
  if (!event) {
    throw new Error(`no event ${eventId} on tournament ${tournamentId}`)
  }
  return event.groups
}

/** One of an event's **stages** (ADR 20260815): its id and its `position` — 0 for a
 * single-stage draw type's only stage, or an `rr-then-ko` event's group stage; 1 for
 * its knockout stage. `getEventGroups`'s own `stage_id` resolves against this. */
export interface StoredStage {
  readonly id: string
  readonly position: number
}

/** Read an event's **stages** back off the tournament detail — the one way a caller
 * of `getEventGroups` tells the group stage's groups apart from the knockout stage's
 * (ADR 20260823, #1484): filter `groups` to the `stage_id` of the stage at
 * `position: 0`. */
export async function getEventStages(
  viewer: Guest,
  tournamentId: string,
  eventId: string,
): Promise<ReadonlyArray<StoredStage>> {
  const res = await viewer.ctx.get(`${API}/tournaments/${tournamentId}`)
  if (!res.ok()) {
    throw new Error(`load tournament failed: ${res.status()} ${await res.text()}`)
  }
  const detail = (await res.json()) as {
    events: ReadonlyArray<{ id: string; stages: ReadonlyArray<StoredStage> }>
  }
  const event = detail.events.find((e) => e.id === eventId)
  if (!event) {
    throw new Error(`no event ${eventId} on tournament ${tournamentId}`)
  }
  return event.stages
}

/**
 * Mint `count` fresh guests and **director-enter** every one of them into the event,
 * returning them so the spec can name them (and dispose their contexts).
 *
 * The fleet exists because some draw shapes only appear at scale: three groups with
 * three players each is nine entrants, and nine self-registrations through the browser
 * would be nine sign-ins to run a test whose subject is the *draw*, not registration.
 * Each guest is minted the same way `mintGuest` mints one — `GET /v1/session` into its
 * own cookie jar — and entered by the director (`enterPlayer`), the seam that has no web
 * UI.
 *
 * Sequential on purpose: entries land in registration order, which is the order the
 * draw deals from (ADR-0786), so a serial loop makes the seeded field deterministic
 * rather than dependent on how nine parallel POSTs happened to interleave.
 *
 * Requires the tournament to be **published** — `enterPlayer` says why.
 */
export async function seedEntrants(
  director: Guest,
  baseURL: string,
  tournamentId: string,
  eventId: string,
  count: number,
): Promise<Guest[]> {
  const entrants: Guest[] = []
  for (let i = 0; i < count; i += 1) {
    const guest = await mintGuest(baseURL)
    // Ephemeral guests are searchable, so the typeahead is how one user's id is
    // resolved from another's session — the same route the opponent picker takes.
    const userId = await findUserId(director, guest.username)
    await enterPlayer(director, tournamentId, eventId, userId)
    entrants.push(guest)
  }
  return entrants
}

/**
 * Move the tournament along one lifecycle edge (`POST …/transitions`,
 * ADR-0017): `published` opens registration, `live` materializes every ready
 * fixture into a real match AND auto-enqueues the initial schedule solve on
 * the stack's real RQ worker (ADR "the schedule is solved; the call is
 * pinned"). Owner-only; the server judges whether the edge is legal.
 */
export async function transitionTournament(
  director: Guest,
  tournamentId: string,
  to: 'published' | 'live' | 'archived',
): Promise<void> {
  const res = await director.ctx.post(
    `${API}/tournaments/${tournamentId}/transitions`,
    {
      headers: { [CSRF_HEADER]: director.csrf },
      data: { to },
    },
  )
  if (res.status() !== 201) {
    throw new Error(
      `transition to ${to} failed: ${res.status()} ${await res.text()}`,
    )
  }
}

/** Cut (or re-cut) an event's draw over the API (`POST …/draw`) — the
 * scaffolding step of a spec whose subject is what happens *after* the cut
 * (scheduling), so the browser is saved for that surface. Owner-only. */
export async function cutDraw(
  director: Guest,
  tournamentId: string,
  eventId: string,
): Promise<void> {
  const res = await director.ctx.post(
    `${API}/tournaments/${tournamentId}/events/${eventId}/draw`,
    { headers: { [CSRF_HEADER]: director.csrf } },
  )
  if (res.status() !== 201) {
    throw new Error(`cut draw failed: ${res.status()} ${await res.text()}`)
  }
}

/** One fixture of the tournament detail, scoped to the scheduling facts a spec
 * reads: who plays (entry refs), the materialized match, the ADR-0790
 * placement columns, and the ADR "the call is pinned" pin facts. */
/** A displayed fixture time (`FixtureTimeRead` on the wire): a UTC `instant` for
 * geometry plus the server-composed venue-local label + tz abbreviation for
 * display (ADR "tournament times are timezone-aware instants"). */
export interface FixtureTime {
  readonly instant: string
  readonly local_label: string
  readonly tz_abbrev: string
}

export interface FixtureDetail {
  readonly id: string
  /** Which of this event's stages the fixture belongs to (ADR 20260815) — the group
   * stage or the knockout stage of an `rr-then-ko` draw, or the single stage of every
   * other draw type. Read because a fixture's `group_id` no longer tells a group-stage
   * fixture apart from a knockout one (ADR 20260823, #1484: every fixture is grouped
   * now) — `stage_id` is the discriminator. */
  readonly stage_id: string
  /** The group this fixture was drawn into — never `null` since #1484: every stage
   * holds a group, so a knockout fixture names one too, just not one any surface
   * labels or ranks (that filter reads `stage_id`, not this). Read because the
   * detail's fixtures arrive **ordered by their group's position within its own
   * stage** (ADR 20260801) — so, WITHIN one stage's fixtures, the order these ids
   * first appear in is the server's statement of that stage's group order. */
  readonly group_id: string
  /** Which round of its draw the fixture belongs to, 1-based. The handle on a bracket's
   * **first round** — the only round of a freshly cut single-elim draw whose fixtures
   * have both sides, and therefore the only one the solver can place at all. */
  readonly round: number
  readonly entry_a_id: string | null
  readonly entry_b_id: string | null
  readonly match_id: string | null
  readonly match_status: string | null
  readonly table_id: string | null
  /** The placement's predicted start (venue-local label + UTC instant), or null. */
  readonly scheduled_start: FixtureTime | null
  /** Null = the placement is an estimate; set = the fixture was CALLED. */
  readonly pinned_at: FixtureTime | null
  readonly call_notified_count: number
}

/** One entrant row — the join key between a fixture's `entry_*_id` refs and
 * the humans (usernames) a spec minted them from. */
export interface EntrantDetail {
  readonly id: string
  readonly user_id: string
  readonly username: string
}

/** The latest run of the schedule solver, as the detail payload carries it. */
export interface SolveDetail {
  readonly id: string
  readonly status: 'queued' | 'running' | 'succeeded' | 'infeasible' | 'failed'
  readonly trigger: string
  readonly verdict: 'optimal' | 'feasible' | null
}

/** The slice of `GET /v1/tournaments/{id}` the solver-schedule spec reads. */
export interface TournamentScheduleDetail {
  readonly events: ReadonlyArray<{
    readonly id: string
    readonly entrants: ReadonlyArray<EntrantDetail>
    readonly fixtures: ReadonlyArray<FixtureDetail>
  }>
  readonly latest_schedule_solve: SolveDetail | null
}

/** Read the tournament detail, typed to the scheduling slice above. The spec
 * uses it as its seed/verify seam: mapping entries to the guests it minted,
 * finding which fixtures the solver pinned, and watching the solve ledger —
 * while the browser stays on the surfaces under test. */
export async function getScheduleDetail(
  viewer: Guest,
  tournamentId: string,
): Promise<TournamentScheduleDetail> {
  const res = await viewer.ctx.get(`${API}/tournaments/${tournamentId}`)
  if (!res.ok()) {
    throw new Error(`load tournament failed: ${res.status()} ${await res.text()}`)
  }
  return (await res.json()) as TournamentScheduleDetail
}

/**
 * Read the tournament detail and return the event's **first fixture** — the one
 * pairing a two-entrant single group cuts. It carries both its own `id` (needed to
 * address its placement, i.e. to call it) and the `match_id` it materialized into
 * at go-live (#788), plus its live `match_status`.
 *
 * A spec uses the `id` to call the fixture (`callFixture`) and the `match_id` to
 * deep-link the browser into the match's score entry the same way
 * `score-conflict.spec.ts` deep-links a seeded match. Throws if the event has no
 * fixtures — which would mean the draw was never cut.
 */
export async function firstFixture(
  viewer: Guest,
  tournamentId: string,
  eventId: string,
): Promise<FixtureDetail> {
  const detail = await getScheduleDetail(viewer, tournamentId)
  const event = detail.events.find((e) => e.id === eventId)
  const fixture = event?.fixtures[0]
  if (!fixture) {
    throw new Error(
      `no fixture for event ${eventId} — was the draw cut?`,
    )
  }
  return fixture
}

/**
 * Read the tournament detail and return the `match_id` of the event's first
 * fixture — the real match a fixture materialized into at go-live (#788).
 *
 * The spec uses it to deep-link the browser into that match's score entry the
 * same way `score-conflict.spec.ts` deep-links a seeded match: learn the URL over
 * the API, drive the surface in the browser. Throws if the fixture has not
 * materialized (no `match_id`) — which would mean go-live had not happened.
 */
export async function firstFixtureMatchId(
  viewer: Guest,
  tournamentId: string,
  eventId: string,
): Promise<string> {
  const matchId = (await firstFixture(viewer, tournamentId, eventId)).match_id
  if (!matchId) {
    throw new Error(
      `no materialized fixture for event ${eventId} — did the tournament go live?`,
    )
  }
  return matchId
}

/** A naive wall-clock ISO timestamp (`YYYY-MM-DDTHH:MM:SS`, **no** timezone
 * suffix) for NOW — the shape `scheduled_start` takes on the wire (ADR-0790). The
 * `slice(0, 19)` drops the milliseconds and the trailing `Z`, so what remains is
 * offset-naive; an offset-aware value is a 422 (`_naive_wall_clock`). */
function naiveNow(): string {
  return new Date().toISOString().slice(0, 19)
}

/**
 * **Call** a fixture to a table by making a full manual placement as the
 * director (ADR "the schedule is solved; the call is pinned"):
 * `PATCH …/fixtures/{fixtureId}/placement` with the seeded catalogue table and a
 * naive wall-clock start.
 *
 * A full placement (both halves set, both entrants known) sets `pinned_at`; and
 * while the tournament is **live**, placing a fixture *is* calling it — the linked
 * match flips `pending → in_progress`, which is what makes it scorable (#1073). So
 * this is how the director takes a freshly-materialized (scheduled, "Not started")
 * fixture live from the API, the same edge a manual drag onto the board is.
 *
 * `scheduled_start` defaults to NOW as a naive wall-clock; the placement is *soft*
 * (an out-of-window time is a flag on read, not a rejection), so a near-now time
 * against a far-future reservation window still calls the match.
 *
 * `tableId` is a **required argument with no default**, and that is the shape of the
 * ADR rather than a style choice: `tournament_fixtures.table_id` is a real foreign key
 * now, so a placement names a table of this tournament's catalogue or it is a 422. This
 * helper has no id it could invent — take one off the seed's `tables`.
 */
export async function callFixture(
  director: Guest,
  tournamentId: string,
  fixtureId: string,
  tableId: string,
  options: { readonly scheduledStart?: string } = {},
): Promise<void> {
  const res = await director.ctx.patch(
    `${API}/tournaments/${tournamentId}/fixtures/${fixtureId}/placement`,
    {
      headers: { [CSRF_HEADER]: director.csrf },
      data: {
        table_id: tableId,
        scheduled_start: options.scheduledStart ?? naiveNow(),
      },
    },
  )
  if (res.status() !== 200) {
    throw new Error(`call fixture failed: ${res.status()} ${await res.text()}`)
  }
}

/**
 * Read a tournament's table catalogue back **as stored** (`GET /v1/tournaments/{id}`),
 * in the catalogue's own order.
 *
 * The seam a removal is judged at: `createTournament` says what the catalogue was at
 * birth, and this says what it is now — which is how "the refusal wrote nothing" and
 * "the confirm removed exactly that one table" become facts read off the server rather
 * than inferred from a card that left the screen.
 */
export async function getTableCatalogue(
  viewer: Guest,
  tournamentId: string,
): Promise<ReadonlyArray<StoredTable>> {
  const res = await viewer.ctx.get(`${API}/tournaments/${tournamentId}`)
  if (!res.ok()) {
    throw new Error(`load tournament failed: ${res.status()} ${await res.text()}`)
  }
  return ((await res.json()) as { table_catalogue: ReadonlyArray<StoredTable> })
    .table_catalogue
}

/**
 * Read back a tournament's stored venue off the detail read (`GET
 * /v1/tournaments/{id}`) — the whole `address` value-object, or **`null` for a
 * tournament with no venue**.
 *
 * The null is the point of returning the object rather than just the coordinates:
 * `address` is nullable on the wire (#1206), so "this tournament really has no
 * venue stored" is a fact a spec has to be able to read, not merely infer from a
 * page that rendered nothing.
 */
export async function getStoredAddress(
  viewer: Guest,
  tournamentId: string,
): Promise<StoredAddress | null> {
  const res = await viewer.ctx.get(`${API}/tournaments/${tournamentId}`)
  if (!res.ok()) {
    throw new Error(`load tournament failed: ${res.status()} ${await res.text()}`)
  }
  return ((await res.json()) as { address: StoredAddress | null }).address
}

/**
 * Read back the coordinates the server geocoded a tournament's venue to, off the
 * detail read's `address` value-object (`GET /v1/tournaments/{id}`).
 *
 * The near-me spec's whole method rests on this: the `FakeGeocoder` is
 * deterministic but its SHA-256 mapping from address to lat/lng is not something
 * a spec should reproduce or hardcode — so a spec seeds an address, then *reads
 * the coordinates back* here and computes its query point/radius from the real,
 * stored numbers. That keeps the assertion robust to the actual coords rather
 * than a guessed literal.
 *
 * Throws on a tournament with **no** venue: a caller asking for coordinates has
 * assumed a located venue, and a silent `(0, 0)` or a `null` threaded onward would
 * turn that mistaken assumption into a bewildering assertion failure elsewhere.
 */
export async function getVenueCoords(
  viewer: Guest,
  tournamentId: string,
): Promise<Coords> {
  const address = await getStoredAddress(viewer, tournamentId)
  if (address === null) {
    throw new Error(
      `tournament ${tournamentId} has NO venue — it has no coordinates to read`,
    )
  }
  return { latitude: address.latitude, longitude: address.longitude }
}

/** One row of the tournament list, scoped to the near-me facts a spec reads:
 * which tournament (`id`) and its server-computed `distance_miles` from the
 * query point (a haversine great-circle distance, in miles; `null` on any read
 * that was not location-filtered). */
export interface NearMeListing {
  readonly id: string
  readonly distance_miles: number | null
}

/** The all-or-nothing near-me query triple the list endpoint accepts: a point
 * plus a radius, in miles. Supplying a partial triple is a 422 by design. */
export interface NearMeQuery {
  readonly lat: number
  readonly lng: number
  readonly radiusMiles: number
}

/** Raw `GET /v1/tournaments` with an arbitrary (possibly partial) near-me query,
 * returning the `APIResponse` so a spec can assert on its status — e.g. that a
 * partial `lat`/`lng`/`radius_miles` triple is a 422. */
export async function listTournamentsRaw(
  viewer: Guest,
  params: Record<string, string | number>,
): Promise<APIResponse> {
  return viewer.ctx.get(`${API}/tournaments`, { params })
}

/**
 * List every tournament visible to `viewer`, **unfiltered** — no near-me triple,
 * so every row's `distance_miles` is `null`.
 *
 * The control for a "not in the radius result" assertion: it establishes that the
 * tournament exists and is visible to this caller, so its absence from a near-me
 * listing is the venue filter doing its job and not a tournament that was never
 * there to find.
 */
export async function listTournaments(
  viewer: Guest,
): Promise<ReadonlyArray<NearMeListing>> {
  const res = await listTournamentsRaw(viewer, {})
  if (!res.ok()) {
    throw new Error(`tournament list failed: ${res.status()} ${await res.text()}`)
  }
  return (await res.json()) as ReadonlyArray<NearMeListing>
}

/**
 * List the tournaments within `radiusMiles` of `(lat, lng)` — the near-me filter
 * through the real API — returning each surviving row's id and its
 * server-computed `distance_miles`. Only the near-me slice is parsed; the cards'
 * other fields are the browser's concern, not this seam's.
 */
export async function listTournamentsNearMe(
  viewer: Guest,
  query: NearMeQuery,
): Promise<ReadonlyArray<NearMeListing>> {
  const res = await listTournamentsRaw(viewer, {
    lat: query.lat,
    lng: query.lng,
    radius_miles: query.radiusMiles,
  })
  if (!res.ok()) {
    throw new Error(`near-me list failed: ${res.status()} ${await res.text()}`)
  }
  return (await res.json()) as ReadonlyArray<NearMeListing>
}
