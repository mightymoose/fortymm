// Builders for the tournament domain objects. These are the shared factories
// the component quartets compose — each produces one realistic, internally
// consistent default (a published two-day open, an Open Singles event, etc.)
// that callers tweak via overrides.

import type {
  Address,
  Entrant,
  EventEntryState,
  Pool,
  Predicate,
  Tournament,
  TournamentEvent,
  TournamentTable,
} from './types'

/** The seeded venue address. Every part is optional in the domain (blank =
 * `''`), so the partial and wholly-blank cases are expressed by overriding
 * parts to `''` — `buildAddress({ venue: '', city: '', region: '' })` — rather
 * than by hand-rolling a second literal at each call site. */
export function buildAddress(overrides: Partial<Address> = {}): Address {
  return {
    venue: 'Berkeley TT Club',
    street: '2727 Milvia St',
    city: 'Berkeley',
    region: 'CA',
    postal: '94703',
    country: 'USA',
    ...overrides,
  }
}

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

/** One entrant — `player.1`, holding entry `entry-1`, unseeded, and **rated**
 * (1450 on the tournament's ladder).
 *
 * Rated is the default because rated is the ordinary case, so a fixture only says
 * `rating: null` when the *unrated* entrant is the thing under test (ADR-0783 §3
 * — the marked one). Pass `rating: null` for that; never a 0, which would be a
 * rating, and a bad one. */
export function buildEntrant(overrides: Partial<Entrant> = {}): Entrant {
  return {
    id: 'entry-1',
    userId: 'u-1',
    username: 'player.1',
    seed: null,
    rating: 1450,
    ...overrides,
  }
}

/** `count` distinct entrants — for the cases that care how MANY players are in
 * an event rather than who they are.
 *
 * `overrides` are applied to *every* one of them, which is what a roster of
 * uniformly **unrated** entrants is built from (`buildEntrants(4, { rating: null })`
 * — the state in which the mark is on every chip and the list must still render). */
export function buildEntrants(
  count: number,
  overrides: Partial<Entrant> = {},
): Entrant[] {
  return Array.from({ length: count }, (_, i) =>
    buildEntrant({
      id: `entry-${i + 1}`,
      userId: `u-${i + 1}`,
      username: `player.${i + 1}`,
      ...overrides,
    }),
  )
}

/** A rated Bo5 Open Singles event, half full (52 of 64), one pool — and
 * therefore `entryState: { state: 'open' }`.
 *
 * `entered` is NOT an override: it is derived from `entrants`, exactly as the
 * server derives it (ADR-0016), so a fixture cannot claim 52 entries while
 * listing none. Want a different count? Pass different `entrants`.
 *
 * `entryState` IS an override — it is the server's judgement about the *caller*
 * (ADR-0783), and rating-ineligibility is not derivable from anything else on the
 * event. But its **default is derived from capacity**, so a fixture cannot
 * accidentally seed a 64-of-64 event that still says `open`: the one arm of the
 * union that *is* a function of the entrants stays consistent with them unless a
 * test deliberately says otherwise. */
export function buildEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  const event = {
    id: 'ev-open-singles',
    name: 'Open Singles',
    format: 'singles',
    drawType: 'rr-then-ko',
    maxPlayers: 64,
    entryFee: 45,
    entrants: buildEntrants(52),
    entryState: { state: 'open' },
    slot: { date: '2026-06-13', start: '09:00', end: '18:00' },
    predicates: [],
    match: { rated: true, lengthGames: 5 },
    pools: [buildPool()],
    ...overrides,
  } satisfies Omit<TournamentEvent, 'entered'>
  // An **uncapped** event (`maxPlayers: null`, ADR-0935) is never `event_full` —
  // the server guarantees it, and so does the fixture. The null check is the whole
  // point of writing it this way round: `entrants.length >= null` coerces the cap
  // to `0`, which makes *every* uncapped fixture full the moment it has one
  // entrant, and a card test seeded from it would then be asserting the bug.
  const entryState: EventEntryState =
    overrides.entryState ??
    (event.maxPlayers !== null && event.entrants.length >= event.maxPlayers
      ? { state: 'event_full' }
      : { state: 'open' })
  return { ...event, entryState, entered: event.entrants.length }
}

/** An event with **no entrant cap** (`max_players: null`, ADR-0935): open to
 * everyone, however many have entered. The roster is deliberately *large* — a
 * fixture of two entrants would render identically whether the card handled the
 * null cap or quietly read it as a big number, so it could not tell the fix from
 * the bug. It carries `entryState: open`, because an uncapped event cannot be
 * `event_full` (the default above derives exactly that). */
export function buildUncappedEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  return buildEvent({
    id: 'ev-club-night',
    name: 'Club Night',
    maxPlayers: null,
    entrants: buildEntrants(23),
    ...overrides,
  })
}

/** An event nobody else can get into: at `max_players`, so the server judges it
 * `event_full` (ADR-0783 §4). Sixteen of sixteen — a small cap, so the fixture's
 * entrants list stays readable. */
export function buildFullEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  return buildEvent({
    id: 'ev-champ-singles',
    name: 'Championship Singles',
    maxPlayers: 16,
    entrants: buildEntrants(16),
    ...overrides,
  })
}

/**
 * A **realistic** rating: the raw Glicko-2 float the server actually puts on the
 * wire, thirteen decimal places and all. Not `1650`.
 *
 * The round number was the blind spot. `entry_state.rating` is interpolated into
 * the "Not eligible" copy, and with a fixture of `1650` the buggy
 * `${state.rating}` and the correct `${formatRating(state.rating)}` produce the
 * *same string* — so the test passed either way and the raw float
 * ("Your rating is 1662.3108939062977.") shipped. A fixture that cannot tell the
 * fix from the bug is not testing the fix: this one can. */
export const UNROUNDED_RATING = 1662.3108939062977

/** An event whose one rule — `rating < 1500` — the caller's rating fails, so the
 * server judges them `rating_ineligible` and names the rule that did it
 * (ADR-0783). The `predicateId` addresses the event's OWN predicate: a fixture
 * whose refusal pointed at a rule the event does not carry would be a payload the
 * server cannot send.
 *
 * The rating it was judged on is `UNROUNDED_RATING` — a float, deliberately (see
 * above): it is what the server sends, and the UI must print it as `1662`. */
export function buildIneligibleEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  const rule = buildPredicate({ id: 'pr-u1500', op: '<', value: 1500 })
  return buildEvent({
    id: 'ev-u1500',
    name: 'U1500 Singles',
    maxPlayers: 48,
    entrants: buildEntrants(4),
    predicates: [rule],
    entryState: {
      state: 'rating_ineligible',
      predicateId: rule.id,
      rating: UNROUNDED_RATING,
    },
    ...overrides,
  })
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
    address: buildAddress(),
    tableIds: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
    events: [buildEvent()],
    ...overrides,
  }
}
