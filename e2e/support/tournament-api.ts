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
): Promise<SeededTournament> {
  const slot = { date: '2026-08-01', start: '09:00', end: '17:00' }

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
      // The pool references this table by id, so the catalogue must carry it.
      table_catalogue: [{ id: TABLE_ID, label: 'Table 1', court: 'A' }],
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
        format: 'singles',
        draw_type: 'round-robin',
        entry_fee: 0,
        slot,
        match_settings: { rated: false, length_games: 1 },
        predicates: [],
        pools: [{ id: POOL_ID, name: 'Pool A', slot, table_ids: [TABLE_ID] }],
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
  const res = await viewer.ctx.get(`${API}/tournaments/${tournamentId}`)
  if (!res.ok()) {
    throw new Error(`load tournament failed: ${res.status()} ${await res.text()}`)
  }
  const detail = (await res.json()) as {
    events: ReadonlyArray<{
      id: string
      fixtures: ReadonlyArray<{ match_id: string | null }>
    }>
  }
  const event = detail.events.find((e) => e.id === eventId)
  const matchId = event?.fixtures.find((f) => f.match_id !== null)?.match_id
  if (!matchId) {
    throw new Error(
      `no materialized fixture for event ${eventId} — did the tournament go live?`,
    )
  }
  return matchId
}
