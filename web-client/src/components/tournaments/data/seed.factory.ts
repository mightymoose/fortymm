// Builders for the tournament domain objects. These are the shared factories
// the component quartets compose — each produces one realistic, internally
// consistent default (a published two-day open, an Open Singles event, etc.)
// that callers tweak via overrides.

import type {
  Pool,
  Predicate,
  Tournament,
  TournamentEvent,
  TournamentTable,
} from './types'

/** A single physical table, `T1` on court 1. */
export function buildTable(
  overrides: Partial<TournamentTable> = {},
): TournamentTable {
  return { id: 't1', label: 'T1', court: '1', ...overrides }
}

/** Twelve tables, `t1`–`t12`, the catalogue the seed tournaments draw from. */
export function buildTables(count = 12): TournamentTable[] {
  return Array.from({ length: count }, (_, i) =>
    buildTable({ id: `t${i + 1}`, label: `T${i + 1}`, court: String(i + 1) }),
  )
}

/** A `rating < 1500` eligibility rule. */
export function buildPredicate(overrides: Partial<Predicate> = {}): Predicate {
  return { id: 'pr-1', field: 'rating', op: '<', value: 1500, ...overrides }
}

/** A four-table morning pool. */
export function buildPool(overrides: Partial<Pool> = {}): Pool {
  return {
    id: 'p-1',
    name: 'Pool A',
    slot: { date: '2026-06-13', start: '09:00', end: '12:30' },
    tableIds: ['t1', 't2', 't3', 't4'],
    ...overrides,
  }
}

/** A rated Bo5 Open Singles event, half full, one pool. */
export function buildEvent(
  overrides: Partial<TournamentEvent> = {},
): TournamentEvent {
  return {
    id: 'ev-open-singles',
    name: 'Open Singles',
    format: 'singles',
    drawType: 'rr-then-ko',
    maxPlayers: 64,
    entryFee: 45,
    entered: 52,
    slot: { date: '2026-06-13', start: '09:00', end: '18:00' },
    predicates: [],
    match: { rated: true, lengthGames: 5 },
    pools: [buildPool()],
    ...overrides,
  }
}

/** The published "Bay Area Open 2026" with a single Open Singles event. */
export function buildTournament(
  overrides: Partial<Tournament> = {},
): Tournament {
  return {
    id: 'bay-area-open-2026',
    name: 'Bay Area Open 2026',
    status: 'published',
    // Existing component factories/tests build the creator's own tournaments,
    // so default to editable; override `canEdit: false` for the read-only case.
    canEdit: true,
    startDate: '2026-06-13',
    endDate: '2026-06-14',
    description: 'Two-day open. USATT-sanctioned, ratings-eligible.',
    address: {
      venue: 'Berkeley TT Club',
      street: '2727 Milvia St',
      city: 'Berkeley',
      region: 'CA',
      postal: '94703',
      country: 'USA',
    },
    tableIds: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
    events: [buildEvent()],
    ...overrides,
  }
}
