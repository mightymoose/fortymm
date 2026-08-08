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
// single pool with a table, and (see `enterPlayer`) the second entrant, added by
// director-entry — for which there is deliberately no web UI today (the entry
// card only self-registers the signed-in player). The director's own entry is
// left for the browser to make through the Enter control.
//
// Everything created here is created **as the director** (the caller's own guest
// context), so the tournament comes back with `can_edit: true` and the browser,
// signed in as that same guest, sees the owner-only controls (Publish, Generate
// draw, Start tournament).

const API = '/api/v1'
const CSRF_HEADER = 'x-csrf-token'

/** The **label** of the one table seeded into the tournament's catalogue, reserved by
 * the event's single pool. A round-robin pool wants at least one table.
 *
 * A label, not an id, because the id is no longer the seed's to choose (see
 * `TableSpec`). */
const TABLE_LABEL = 'Table 1'
/** The **name** of the event's single pool — a round-robin needs ≥1 pool, and two
 * entrants in one pool is exactly one fixture: the minimal playable draw.
 *
 * A name, not an id, for the same reason `TABLE_LABEL` is a label: the id is no longer
 * the seed's to choose (see `PoolSpec`). */
const POOL_NAME = 'Pool A'

/** A pool/event window (`Slot` on the wire): a date plus `HH:MM` bounds, all
 * naive wall-clock strings in the venue's frame (ADR-0790). */
export interface SlotSpec {
  readonly date: string
  readonly start: string
  readonly end: string
}

/** Tomorrow, `YYYY-MM-DD`, UTC — the date a seeded window sits on. The default pool
 * window uses it, and so does any spec that builds its own `SlotSpec`, so the rule lives
 * here once.
 *
 * **Computed, never a literal.** This used to be the string `'2026-08-01'`, which
 * was comfortably far-future when it was written and then arrived: from 17:00 UTC
 * that day every seeded window was in the *past*, and from the next day it was
 * permanently so. The schedule preview solves fixtures into their pool's window,
 * and a window behind `now` admits no placement — so the solve is honestly
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
 * So nothing here names a table by id. A pool cites the tables it reserves by
 * **label** (`PoolSpec.tableLabels`), and anything that needs the real id reads it back
 * off the create response (`StoredTable`, returned by `createTournament` and
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
 * keyed by: a fixture's `table_id`, the schedule board's table sections, a pool's
 * `table_ids`. */
export interface StoredTable {
  readonly id: string
  readonly label: string
  readonly court: string
}

/** One pool of the event's draw, as a **client sends it** (`PoolWrite` on the wire):
 * what it is called and which tables it reserves, and deliberately **neither an `id` nor
 * a `position`**.
 *
 * Both absences are the wire's, not this helper's taste. `PoolWrite` is `extra="forbid"`
 * and has no field for either, so a seed supplying its own `pool-a` is a **422 naming
 * `body.pools[i].id`** — which is exactly how this helper broke when a pool became a real
 * row with a `gen_random_uuid()` primary key (ADR 20260801). The id is the database's
 * now, the same as a catalogue table's.
 *
 * So nothing here names a pool by id:
 *
 * - a pool is written down by **name**, which is also what the draw renders and what a
 *   spec's ordering assertions read;
 * - a pool cites the tables it reserves by **label** (`tableLabels`), resolved against
 *   the catalogue `seedTournament` just created — the ids are minted too;
 * - anything that needs the real pool id reads it back off the create response
 *   (`StoredPool`, returned by `seedTournament`).
 *
 * The **order of `SeedTournamentOptions.pools`** is therefore the payload's one statement
 * about pool order: the server stamps each pool's `position` from its index in the list
 * it was sent (ADR 20260801, "Pools carry an explicit `position`"), and that is what the
 * draw, the deal and the rendered pool sections are all ordered by.
 *
 * `tableLabels` is optional because the single-pool default reserves the whole catalogue;
 * a multi-pool seed usually wants a table each, so ten pools raise no double-booking
 * warning over one shared table.
 *
 * `tableIdsFor` throws on a label that names no seeded table rather than sending a
 * reservation the solver would quietly intersect away to nothing. */
export interface PoolSpec {
  readonly name: string
  /** The catalogue tables this pool reserves, **by label**. Omitted = **every** seeded
   * table. */
  readonly tableLabels?: ReadonlyArray<string>
}

/** One pool as the API **reads it back** (`Pool` on the wire): what was sent, plus the
 * uuid the server minted for it and the 0-based `position` it stamped from the pool's
 * index in the list it arrived in (ADR 20260801).
 *
 * The only place a spec can learn a pool id — and the id everything downstream is keyed
 * by: a fixture's `pool_id`, the draw's pool sections, the `pool-standings-{id}` table.
 * Only the three fields an ordering assertion is about are named; the window and tables
 * ride along untyped. */
export interface StoredPool {
  readonly id: string
  readonly name: string
  readonly position: number
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

/** The draw types this seed can author. Two, because these are the two shapes the seed
 * itself can express: `round-robin`, whose draw settings are the empty object, and
 * `single-elim`, whose settings are empty too (`SingleElimDrawSettingsWrite` — a bracket
 * has no pools to qualify out of and its depth is derived from the field).
 *
 * The two formats that DO carry a setting are deliberately absent. `rr-then-ko` needs
 * `qualifiers_per_pool` and `swiss` needs `rounds`, both **required with no default** on
 * their arm of the server's draw-settings union — and both are authored through the event
 * editor **in the browser** by the specs that use them, because the payload that editor
 * builds is the seam their 422 lived in. Adding them here would give those specs a way to
 * skip the surface they exist to test. */
export type SeededDrawType = 'round-robin' | 'single-elim'

/** Optional knobs on `seedTournament`. Defaults reproduce the original minimal
 * shape (one round-robin, one table, one pool, a far-future window), so existing specs
 * are untouched; the solver-schedule spec overrides two of them — its pool window must
 * bracket the stack's real NOW for the call-ahead pinning to fire naturally,
 * and a 4-entrant round-robin wants two tables to run its rounds in parallel. */
export interface SeedTournamentOptions {
  /** The event's draw type. Omitted = `round-robin`, the original minimal shape.
   *
   * `single-elim` is what `tournament-single-elim-schedule.spec.ts` seeds, and it is
   * seeded **with `pools: []`**: a bracket is un-pooled end to end (ADR-0786), so a pool
   * on such an event would reserve a slice of the venue no fixture is ever drawn into —
   * and the spec's whole subject is what the scheduler does with a fixture that names no
   * pool (ADR 20260807, "a pool restricts scheduling, it does not enable it"). */
  readonly drawType?: SeededDrawType
  /** The window both the event and its single pool carry. */
  readonly slot?: SlotSpec
  /** The table catalogue; the pool references every listed table. */
  readonly tables?: ReadonlyArray<TableSpec>
  /** The event's pools, **in the director's order** — omitted = the original single
   * `Pool A` over the whole catalogue, so existing specs are untouched. **`[]` seeds an
   * event with NO pools**, which is what an un-pooled draw type wants: the create verb
   * takes any number of pools, zero included, and `??` leaves an explicit empty list
   * alone (only an *omitted* option falls back to the default).
   *
   * The list's order is the whole point of the option: it is what the server turns into
   * the stored `position`s, and therefore what the draw, the deal and the rendered pool
   * sections are all ordered by. A caller seeding several pools is making a statement
   * about their order whether it means to or not. */
  readonly pools?: ReadonlyArray<PoolSpec>
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
  /** The event's pools **as stored** — read off the create response, so each carries the
   * uuid the server minted and the `position` it stamped, in the order they were sent.
   * The only handle a spec has on a pool id, and the order the draw must read in. */
  readonly pools: ReadonlyArray<StoredPool>
  /** The event's **first** pool id — its only one under the default seed — so a spec
   * can scope its standings assertions without indexing `pools` itself.
   *
   * **`null` for a seed with no pools** (`pools: []`, an un-pooled draw type). Nullable
   * rather than "the first element of a possibly-empty list", which reads as a `string`
   * and is `undefined`: a pool-less event has no first pool, and saying so here is what
   * stops that `undefined` travelling into a locator and resolving nothing. */
  readonly poolId: string | null
}

/**
 * Create a **draft** tournament and nothing else — no events.
 *
 * The empty shell is a first-class seed, not half of `seedTournament`: an event is the
 * subject of some specs rather than their scaffolding. `tournament-rr-then-ko.spec.ts`
 * authors its event through the **event editor in the browser**, because the payload
 * that editor builds — specifically whether it carries `qualifiers_per_pool` — is the
 * exact seam the arc's 422 lived in, and an event seeded here by hand-written JSON
 * would prove only that the *server* accepts the field.
 *
 * The table catalogue is still seeded (a pool references its tables by id, and the
 * browser has no way to invent one), as is the venue — see `SeedTournamentOptions` for
 * what `address: null` means.
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
      // A pool references these tables by id, so the catalogue must carry them —
      // sent WITHOUT ids (see `TableSpec`), and read back below with the ones the
      // server minted.
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
 * best-of-1 event, drawn across a single pool that holds one table — the minimal
 * shape that can go live and produce a champion. `options.pools` seeds several
 * instead, in the order given (see `PoolSpec`).
 *
 * `rated: false` + `length_games: 1` is load-bearing, not incidental: an unrated
 * tournament match takes the immediate self-accept completion path, so recording
 * its result COMPLETES it with no second party accepting — one browser session
 * can drive the whole thing. `max_players` is left uncapped (omitted): the spec
 * enters exactly two, and a cap only adds a way to fail.
 *
 * Two API calls, both as the director: `POST /tournaments` then
 * `POST /tournaments/{id}/events`. The lifecycle (publish → cut → go live) and
 * the entries are the browser's job.
 */
export async function seedTournament(
  director: Guest,
  name: string,
  options: SeedTournamentOptions = {},
): Promise<SeededTournament> {
  const slot = options.slot ?? {
    date: tomorrowUtc(),
    start: '09:00',
    end: '17:00',
  }
  const tables = options.tables ?? [{ label: TABLE_LABEL, court: 'A' }]
  const pools = options.pools ?? [{ name: POOL_NAME }]
  // Resolve the catalogue HERE and pass it down, rather than letting
  // `createTournament` default it again: the pools below reserve tables out of the
  // catalogue it creates, so the two must be the same list by construction. What comes
  // back (`storedTables`) is that same list carrying the ids the server minted — the
  // only form in which a pool can name a table on the wire.
  const { tournamentId, tables: storedTables } = await createTournament(
    director,
    name,
    { ...options, tables },
  )

  const eventRes = await director.ctx.post(
    `${API}/tournaments/${tournamentId}/events`,
    {
      headers: { [CSRF_HEADER]: director.csrf },
      data: {
        name: 'Open Singles',
        // The compose stack's clock is UTC, and the solver-schedule spec builds
        // its pool window around the stack's real NOW; anchoring the event to
        // UTC keeps a naive wall-clock window resolving to the same instant it
        // did before events carried a venue timezone (ADR "tournament times are
        // timezone-aware instants"), so the window still brackets NOW.
        timezone: 'UTC',
        format: 'singles',
        // The caller's draw type, defaulting to the original round-robin. Both types
        // this seed can author take **no** further draw settings, so there is nothing
        // to send beside it (see `SeededDrawType` for the two that do, and why they
        // are authored in the browser instead).
        draw_type: options.drawType ?? 'round-robin',
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
        // what `stored_pools` stamps the pools' `position`s from, so re-ordering it —
        // even "tidily", by name — would silently seed a different event than the one the
        // spec asked for. No pool carries an `id` or a `position` key either; sending
        // either is a 422 naming it (`PoolWrite` is `extra="forbid"` and has neither
        // field).
        pools: pools.map((pool) => ({
          name: pool.name,
          slot,
          // Labels resolved to the ids the server just minted — a pool's `table_ids`
          // are catalogue ids on the wire, and a stale one is silently intersected
          // away by the solver ("a stale ref is a table the pool cannot use"), so a
          // typo would surface as an inexplicably infeasible day rather than an error.
          table_ids: tableIdsFor(storedTables, pool.tableLabels),
        })),
      },
    },
  )
  if (eventRes.status() !== 201) {
    throw new Error(
      `create event failed: ${eventRes.status()} ${await eventRes.text()}`,
    )
  }
  // `TournamentEventRead` carries the stored pools, ordered by the `position` the server
  // just stamped (the relationship's own `order_by`) — so the minted ids come back on the
  // create itself, in the order they were sent, and no second read is needed to learn
  // them.
  const created = (await eventRes.json()) as {
    id: string
    pools: ReadonlyArray<StoredPool>
  }
  if (created.pools.length !== pools.length) {
    throw new Error(
      `seeded ${pools.length} pools but the event stored ${created.pools.length}`,
    )
  }

  return {
    tournamentId,
    tables: storedTables,
    eventId: created.id,
    pools: created.pools,
    poolId: created.pools[0]?.id ?? null,
  }
}

/** Resolve a pool's reserved-table **labels** to the catalogue ids the wire wants;
 * omitted labels reserve the whole catalogue (the single-pool default).
 *
 * Throws on a label the catalogue does not hold. That is not defensiveness for its own
 * sake: an unresolvable label sent as-is would be a table the pool "reserves" and the
 * solver cannot see, so the seed would look fine and the day would come back
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
        `pool reserves "${label}", which the seeded catalogue does not hold — has: ${known}`,
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
 * `draw_type` and `qualifiers_per_pool` are one fact in two columns (ADR 20260727), so
 * they are read as a pair. Reading them back is what turns "the create request did not
 * 422" into "the server holds the configuration the director typed" — a 201 alone would
 * also be returned by a server that had quietly dropped K. */
export interface EventDrawConfig {
  readonly id: string
  readonly name: string
  readonly draw_type: string
  /** **K**. `null` for every draw type that has no knockout stage to qualify for. */
  readonly qualifiers_per_pool: number | null
  /** **R** — how many rounds a `swiss` event plays. `null` for every other draw type,
   * which does not ask the question (a round-robin's rounds fall out of the circle
   * method, a bracket's depth out of the field).
   *
   * Read back for the reason `qualifiers_per_pool` is: it is **required with no default**
   * on the swiss arm of the server's draw-settings union, so it is the field a create
   * body is refused for omitting — and a 201 alone would also come back from a server
   * that accepted the body and dropped R on the floor. */
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
 * Read an event's pools back off the tournament detail, **as stored**.
 *
 * This is the one seam that can say whether the server took the order the director sent
 * and made it a fact: a client cannot send a `position` at all (`PoolWrite` is
 * `extra="forbid"` — it is a 422), so every position on the wire was assigned here. A
 * spec that only read the rendered page could not tell "the server ordered them" from
 * "the client re-derived an order that happened to agree".
 *
 * The pools are returned **exactly as the payload carries them**, unsorted, so a caller
 * asserting on the order is asserting on the server's, not on this helper's.
 */
export async function getEventPools(
  viewer: Guest,
  tournamentId: string,
  eventId: string,
): Promise<ReadonlyArray<StoredPool>> {
  const res = await viewer.ctx.get(`${API}/tournaments/${tournamentId}`)
  if (!res.ok()) {
    throw new Error(`load tournament failed: ${res.status()} ${await res.text()}`)
  }
  const detail = (await res.json()) as {
    events: ReadonlyArray<{ id: string; pools: ReadonlyArray<StoredPool> }>
  }
  const event = detail.events.find((e) => e.id === eventId)
  if (!event) {
    throw new Error(`no event ${eventId} on tournament ${tournamentId}`)
  }
  return event.pools
}

/**
 * Mint `count` fresh guests and **director-enter** every one of them into the event,
 * returning them so the spec can name them (and dispose their contexts).
 *
 * The fleet exists because some draw shapes only appear at scale: three pools with three
 * players each is nine entrants, and nine self-registrations through the browser would
 * be nine sign-ins to run a test whose subject is the *draw*, not registration. Each
 * guest is minted the same way `mintGuest` mints one — `GET /v1/session` into its own
 * cookie jar — and entered by the director (`enterPlayer`), the seam that has no web UI.
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
  /** The pool this fixture was drawn into, or `null` for an un-pooled one (a knockout
   * slot). Read because the detail's fixtures arrive **ordered by their pool's
   * position** (ADR 20260801) — so the order these ids first appear in *is* the
   * server's statement of the event's pool order, before any client touches it. */
  readonly pool_id: string | null
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
 * pairing a two-entrant single pool cuts. It carries both its own `id` (needed to
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
 * against a far-future pool window still calls the match.
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
