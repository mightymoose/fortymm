import type { components } from '@/api/schema'

type TournamentDetailRead = components['schemas']['TournamentDetailRead']
type TournamentEventRead = components['schemas']['TournamentEventRead']
type TournamentEntrantRead = components['schemas']['TournamentEntrantRead']
type TournamentTable = components['schemas']['TournamentTable']

/** A single physical table, `T1` on court 1. */
export function buildTournamentTable(
  overrides: Partial<TournamentTable> = {},
): TournamentTable {
  return { id: 't1', label: 'T1', court: '1', ...overrides }
}

/** One active entrant. `id` is the ENTRY's id — the address a withdrawal is
 * sent to (`DELETE …/entries/{entry_id}`) — not the player's. */
export function buildTournamentEntrantRead(
  overrides: Partial<TournamentEntrantRead> = {},
): TournamentEntrantRead {
  return {
    id: 'entry-1',
    user_id: 'u-rita',
    username: 'rita.kovac',
    seed: null,
    ...overrides,
  }
}

/** `count` distinct entrants (`entry-1`/`player.1`, `entry-2`/`player.2`, …) —
 * for the cases that care about how MANY entrants an event has, not who. */
export function buildTournamentEntrantReads(
  count: number,
): TournamentEntrantRead[] {
  return Array.from({ length: count }, (_, i) =>
    buildTournamentEntrantRead({
      id: `entry-${i + 1}`,
      user_id: `u-${i + 1}`,
      username: `player.${i + 1}`,
    }),
  )
}

/**
 * A rated Bo5 "Open Singles" event with one morning pool, as returned by the
 * tournament detail/list endpoints. Defaults are internally consistent so a
 * bare call is a meaningful row.
 *
 * `entered` is NOT an override: like the server (ADR-0016) it is derived from
 * `entrants`, so this factory cannot mint an event whose count disagrees with
 * its list. Want an event with 22 entries? Give it 22 `entrants`.
 */
export function buildTournamentEventRead(
  overrides: Partial<Omit<TournamentEventRead, 'entered'>> = {},
): TournamentEventRead {
  const event = {
    id: 'ev-open-singles',
    tournament_id: 'bay-area-open-2026',
    name: 'Open Singles',
    format: 'singles',
    draw_type: 'rr-then-ko',
    max_players: 64,
    entry_fee: 45,
    entrants: [],
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
    ],
    created_at: '2026-06-01T09:05:00Z',
    updated_at: '2026-06-09T12:00:00Z',
    ...overrides,
  } satisfies Omit<TournamentEventRead, 'entered'>
  return { ...event, entered: event.entrants.length }
}

/**
 * The published "Bay Area Open 2026" with a four-table catalogue and a single
 * Open Singles event, owned (editable) by the current user. The list and detail
 * endpoints both return this `TournamentDetailRead` shape.
 */
export function buildTournamentDetailRead(
  overrides: Partial<TournamentDetailRead> = {},
): TournamentDetailRead {
  return {
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
    table_catalogue: [
      buildTournamentTable({ id: 't1', label: 'T1', court: '1' }),
      buildTournamentTable({ id: 't2', label: 'T2', court: '2' }),
      buildTournamentTable({ id: 't3', label: 'T3', court: '3' }),
      buildTournamentTable({ id: 't4', label: 'T4', court: '4' }),
    ],
    created_by_user_id: 'u-me',
    created_by_username: 'rita.kovac',
    can_edit: true,
    created_at: '2026-06-01T09:00:00Z',
    updated_at: '2026-06-10T12:00:00Z',
    events: [buildTournamentEventRead()],
    ...overrides,
  }
}
