// Dev-only in-memory store backing the MSW `/v1/tournaments` handlers. There is
// no backend in `npm run dev`: the seed loads once, mutations rewrite this
// module's array, and everything resets on reload. PATCH/DELETE (tournament and
// event) enforce the same creator-only rule the real API does — a
// `can_edit: false` row (created by someone else) returns 403.

import type { components } from '@/api/schema'

type TournamentDetailRead = components['schemas']['TournamentDetailRead']
type TournamentRead = components['schemas']['TournamentRead']
type TournamentEventRead = components['schemas']['TournamentEventRead']
type TournamentCreate = components['schemas']['TournamentCreate']
type TournamentUpdate = components['schemas']['TournamentUpdate']
type TournamentEventCreate = components['schemas']['TournamentEventCreate']
type TournamentEventUpdate = components['schemas']['TournamentEventUpdate']
type TournamentTable = components['schemas']['TournamentTable']

// The dev current user — must line up with the mocked session in handlers.ts so
// `can_edit` reads true for rows this user owns.
const DEV_USER_ID = 'u-me'
const DEV_USERNAME = 'rita.kovac'

function tables(count: number): TournamentTable[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i + 1}`,
    label: `T${i + 1}`,
    court: String(i + 1),
  }))
}

function seed(): TournamentDetailRead[] {
  return [
    {
      id: 'bay-area-open-2026',
      name: 'Bay Area Open 2026',
      description: 'Two-day open. USATT-sanctioned, ratings-eligible.',
      status: 'published',
      start_date: '2026-06-13',
      end_date: '2026-06-14',
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
          entered: 52,
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
          id: 'ev-u1500',
          tournament_id: 'bay-area-open-2026',
          name: 'U1500 Singles',
          format: 'singles',
          draw_type: 'rr-then-ko',
          max_players: 48,
          entry_fee: 30,
          entered: 41,
          slot: { date: '2026-06-14', start: '09:00', end: '16:00' },
          match_settings: { rated: true, length_games: 3 },
          predicates: [{ id: 'pr-2', field: 'rating', op: '<', value: 1500 }],
          pools: [],
          created_at: '2026-06-01T09:06:00Z',
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
      status: 'live',
      start_date: '2026-07-01',
      end_date: '2026-07-01',
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
          id: 'ev-cc-open',
          tournament_id: 'club-champs-2026',
          name: 'Championship Singles',
          format: 'singles',
          draw_type: 'single-elim',
          max_players: 32,
          entry_fee: 40,
          entered: 28,
          slot: { date: '2026-07-01', start: '17:00', end: '21:00' },
          match_settings: { rated: true, length_games: 5 },
          predicates: [],
          pools: [],
          created_at: '2026-05-20T10:05:00Z',
          updated_at: '2026-06-12T08:00:00Z',
        },
      ],
    },
  ]
}

let tournaments: TournamentDetailRead[] = seed()

/** Reset the store to its seed — used by the dev worker bootstrap if needed. */
export function resetTournamentsStore() {
  tournaments = seed()
}

/** The list, newest-created first (mirrors the API's ordering). */
export function listTournaments(): TournamentDetailRead[] {
  return tournaments
    .slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

/** A single tournament's detail, or `undefined` if missing. */
export function findTournament(id: string): TournamentDetailRead | undefined {
  return tournaments.find((t) => t.id === id)
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
 * the `TournamentRead` (no events — create makes a bare tournament). */
export function createTournament(body: TournamentCreate): TournamentRead {
  const now = new Date().toISOString()
  const id = slugId(body.name)
  const created: TournamentDetailRead = {
    id,
    name: body.name,
    description: body.description ?? null,
    status: body.status ?? 'draft',
    start_date: body.start_date ?? null,
    end_date: body.end_date ?? null,
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

/** Strip the embedded `events` so the create/update handlers return the bare
 * `TournamentRead` the real API does. */
function readOf({ events, ...read }: TournamentDetailRead): TournamentRead {
  void events
  return read
}

/** Patch a tournament's top-level fields. Non-owned rows (`can_edit: false`)
 * return 403; a missing id returns 404 — mirroring the real API's gating. */
export function updateTournament(
  id: string,
  patch: TournamentUpdate,
): StoreResult {
  const existing = tournaments.find((t) => t.id === id)
  if (!existing) return { ok: false, status: 404 }
  if (!existing.can_edit) return { ok: false, status: 403 }
  const next: TournamentDetailRead = {
    ...existing,
    name: patch.name ?? existing.name,
    description:
      patch.description === undefined ? existing.description : patch.description,
    status: patch.status ?? existing.status,
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
  tournaments = tournaments.map((t) => (t.id === id ? next : t))
  return { ok: true, tournament: readOf(next) }
}

/** Delete a tournament. Same gating as update. */
export function deleteTournament(id: string): DeleteResult {
  const existing = tournaments.find((t) => t.id === id)
  if (!existing) return { ok: false, status: 404 }
  if (!existing.can_edit) return { ok: false, status: 403 }
  tournaments = tournaments.filter((t) => t.id !== id)
  return { ok: true }
}

let eventCounter = 0

/** Create an event on a tournament. Creator-only (403 on a non-owned row). */
export function createEvent(
  tournamentId: string,
  body: TournamentEventCreate,
): EventResult {
  const existing = tournaments.find((t) => t.id === tournamentId)
  if (!existing) return { ok: false, status: 404 }
  if (!existing.can_edit) return { ok: false, status: 403 }
  eventCounter += 1
  const now = new Date().toISOString()
  const event: TournamentEventRead = {
    id: `ev-new-${eventCounter}`,
    tournament_id: tournamentId,
    name: body.name,
    format: body.format,
    draw_type: body.draw_type,
    max_players: body.max_players,
    entry_fee: body.entry_fee,
    entered: body.entered ?? 0,
    slot: body.slot,
    match_settings: body.match_settings,
    predicates: body.predicates ?? [],
    pools: body.pools ?? [],
    created_at: now,
    updated_at: now,
  }
  const next = { ...existing, events: [...existing.events, event] }
  tournaments = tournaments.map((t) => (t.id === tournamentId ? next : t))
  return { ok: true, event }
}

/** Patch an event (full replace of the provided fields). Creator-only. */
export function updateEvent(
  tournamentId: string,
  eventId: string,
  patch: TournamentEventUpdate,
): EventResult {
  const existing = tournaments.find((t) => t.id === tournamentId)
  if (!existing) return { ok: false, status: 404 }
  if (!existing.can_edit) return { ok: false, status: 403 }
  const event = existing.events.find((e) => e.id === eventId)
  if (!event) return { ok: false, status: 404 }
  const next: TournamentEventRead = {
    ...event,
    name: patch.name ?? event.name,
    format: patch.format ?? event.format,
    draw_type: patch.draw_type ?? event.draw_type,
    max_players: patch.max_players ?? event.max_players,
    entry_fee: patch.entry_fee ?? event.entry_fee,
    entered: patch.entered ?? event.entered,
    slot: patch.slot ?? event.slot,
    match_settings: patch.match_settings ?? event.match_settings,
    predicates: patch.predicates ?? event.predicates,
    pools: patch.pools ?? event.pools,
    updated_at: new Date().toISOString(),
  }
  const nextTournament = {
    ...existing,
    events: existing.events.map((e) => (e.id === eventId ? next : e)),
  }
  tournaments = tournaments.map((t) =>
    t.id === tournamentId ? nextTournament : t,
  )
  return { ok: true, event: next }
}

/** Delete an event. Creator-only. */
export function deleteEvent(
  tournamentId: string,
  eventId: string,
): DeleteResult {
  const existing = tournaments.find((t) => t.id === tournamentId)
  if (!existing) return { ok: false, status: 404 }
  if (!existing.can_edit) return { ok: false, status: 403 }
  const event = existing.events.find((e) => e.id === eventId)
  if (!event) return { ok: false, status: 404 }
  const next = {
    ...existing,
    events: existing.events.filter((e) => e.id !== eventId),
  }
  tournaments = tournaments.map((t) => (t.id === tournamentId ? next : t))
  return { ok: true }
}
