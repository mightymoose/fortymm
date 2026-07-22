import type { Guest } from './match-api'

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

/** The id of the one table seeded into the tournament's catalogue, referenced by
 * the event's single pool. A round-robin pool wants at least one table. */
const TABLE_ID = 't1'
/** The id of the event's single pool — a round-robin needs ≥1 pool, and two
 * entrants in one pool is exactly one fixture: the minimal playable draw. */
const POOL_ID = 'pool-a'

/** A pool/event window (`Slot` on the wire): a date plus `HH:MM` bounds, all
 * naive wall-clock strings in the venue's frame (ADR-0790). */
export interface SlotSpec {
  readonly date: string
  readonly start: string
  readonly end: string
}

/** One table of the tournament's catalogue (`TournamentTable` on the wire). */
export interface TableSpec {
  readonly id: string
  readonly label: string
  readonly court: string
}

/** Optional knobs on `seedTournament`. Defaults reproduce the original minimal
 * shape (one table, one pool, a far-future window), so existing specs are
 * untouched; the solver-schedule spec overrides both — its pool window must
 * bracket the stack's real NOW for the call-ahead pinning to fire naturally,
 * and a 4-entrant round-robin wants two tables to run its rounds in parallel. */
export interface SeedTournamentOptions {
  /** The window both the event and its single pool carry. */
  readonly slot?: SlotSpec
  /** The table catalogue; the pool references every listed table. */
  readonly tables?: ReadonlyArray<TableSpec>
  /** The event's `max_players` cap. Omitted = uncapped (the original minimal
   * shape). The schedule-preview spec sets a small cap so the synthetic field a
   * preview auto-fills to (an uncapped event defaults to 16) is small enough that
   * the real solver returns a fast, clean "fits" verdict rather than an
   * over-the-cap `unknown`. */
  readonly maxPlayers?: number
}

/** A seeded tournament and the ids a spec needs to address it and its event. */
export interface SeededTournament {
  readonly tournamentId: string
  readonly eventId: string
  /** The event's single pool id, so a spec can scope its standings assertions. */
  readonly poolId: string
}

/**
 * Create a **draft** tournament with one singles, **round-robin**, **unrated**,
 * best-of-1 event, drawn across a single pool that holds one table — the minimal
 * shape that can go live and produce a champion.
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
  const slot = options.slot ?? { date: '2026-08-01', start: '09:00', end: '17:00' }
  const tables = options.tables ?? [{ id: TABLE_ID, label: 'Table 1', court: 'A' }]

  const tournamentRes = await director.ctx.post(`${API}/tournaments`, {
    headers: { [CSRF_HEADER]: director.csrf },
    data: {
      name,
      address: {
        venue: 'Test Arena',
        street: '1 Test Way',
        city: 'Testville',
        region: 'TS',
        postal: '00000',
        country: 'Testland',
      },
      // The pool references these tables by id, so the catalogue must carry them.
      table_catalogue: tables,
    },
  })
  if (tournamentRes.status() !== 201) {
    throw new Error(
      `create tournament failed: ${tournamentRes.status()} ${await tournamentRes.text()}`,
    )
  }
  const tournamentId = ((await tournamentRes.json()) as { id: string }).id

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
        draw_type: 'round-robin',
        entry_fee: 0,
        // Only sent when the caller caps the field; omitting the key leaves the
        // event uncapped (the API treats a missing `max_players` as no cap).
        ...(options.maxPlayers !== undefined
          ? { max_players: options.maxPlayers }
          : {}),
        slot,
        match_settings: { rated: false, length_games: 1 },
        predicates: [],
        pools: [
          {
            id: POOL_ID,
            name: 'Pool A',
            slot,
            table_ids: tables.map((table) => table.id),
          },
        ],
      },
    },
  )
  if (eventRes.status() !== 201) {
    throw new Error(
      `create event failed: ${eventRes.status()} ${await eventRes.text()}`,
    )
  }
  const eventId = ((await eventRes.json()) as { id: string }).id

  return { tournamentId, eventId, poolId: POOL_ID }
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
 */
export async function callFixture(
  director: Guest,
  tournamentId: string,
  fixtureId: string,
  options: { readonly tableId?: string; readonly scheduledStart?: string } = {},
): Promise<void> {
  const res = await director.ctx.patch(
    `${API}/tournaments/${tournamentId}/fixtures/${fixtureId}/placement`,
    {
      headers: { [CSRF_HEADER]: director.csrf },
      data: {
        table_id: options.tableId ?? TABLE_ID,
        scheduled_start: options.scheduledStart ?? naiveNow(),
      },
    },
  )
  if (res.status() !== 200) {
    throw new Error(`call fixture failed: ${res.status()} ${await res.text()}`)
  }
}
