// Builders for the tournament domain objects. These are the shared factories
// the component quartets compose — each produces one realistic, internally
// consistent default (a published two-day open, an Open Singles event, etc.)
// that callers tweak via overrides.

import type {
  Address,
  Entrant,
  EventEntryState,
  EventResults,
  Fixture,
  Pool,
  PoolStandings,
  Predicate,
  StandingRow,
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
    // NO DRAW CUT (ADR-0786) — `[]` is the designed state of an event whose director
    // has not cut one, and it is the state every event starts in. An override, not a
    // derivation: the same field makes a different draw across two pools than across
    // three, so a fixture that quietly cut one would be inventing a decision.
    fixtures: [],
    // NO RESULTS (ADR-0788) — `null` is the designed state of an event with no draw (and
    // of any non-round-robin event): there is nothing to stand. Standings only appear once
    // a draw is cut, so a bare event carries `null` and the tests that want a table pass a
    // `buildEventResults` override (or use `buildStandingsEvent`).
    results: null,
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

/** One fixture of a cut draw (ADR-0786): round 1, position 1 of `Pool A`, between the
 * first two entrants, undecided and not yet a match.
 *
 * Every `null` is a fact, so none of them is a default worth having *silently*: pass
 * `entryBId: null` for a **TBD** side (never a bye — a bye is the ABSENCE of a fixture),
 * `poolId: null` for an un-pooled (knockout) fixture. */
export function buildFixture(overrides: Partial<Fixture> = {}): Fixture {
  return {
    id: 'fx-1',
    poolId: 'p-a',
    round: 1,
    position: 1,
    entryAId: 'entry-1',
    entryBId: 'entry-2',
    winnerEntryId: null,
    matchId: null,
    matchStatus: null,
    ...overrides,
  }
}

/**
 * An event whose draw **is cut**: a round-robin U1200 Singles, five entrants
 * (`player.1`…`player.5`) dealt across two pools by the snake the API uses, and the
 * fixtures that field really produces.
 *
 *     Pool A — player.1, player.4, player.5   (ODD: 3 rounds of ONE fixture)
 *     Pool B — player.2, player.3             (1 round of one fixture)
 *
 * The odd pool is the point of the fixture. Pool A's rounds hold one fixture each
 * because the third player **sits that round out** — and that is all a bye is
 * (ADR-0786: "a bye is modeled as absence"; an odd round-robin pool simply has fewer
 * fixtures per round). A factory that dealt two even pools could not tell a renderer
 * that invents a "bye" row from one that doesn't.
 *
 * The fixtures are listed in the server's order (pool → round → position). A test that
 * wants to prove the panel *sorts* rather than trusting that order passes a shuffled
 * `fixtures` override.
 */
export function buildDrawnEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  return buildEvent({
    id: 'ev-u1200',
    name: 'U1200 Singles',
    drawType: 'round-robin',
    maxPlayers: 24,
    entrants: buildEntrants(5),
    pools: [
      buildPool({ id: 'p-a', name: 'Pool A' }),
      buildPool({
        id: 'p-b',
        name: 'Pool B',
        slot: { date: '2026-06-13', start: '13:30', end: '17:00' },
      }),
    ],
    fixtures: [
      // Pool A: the all-play-all of players 1, 4 and 5 — one fixture a round, the third
      // player sitting out each time.
      buildFixture({
        id: 'fx-a-1',
        poolId: 'p-a',
        round: 1,
        position: 1,
        entryAId: 'entry-1',
        entryBId: 'entry-4',
      }),
      buildFixture({
        id: 'fx-a-2',
        poolId: 'p-a',
        round: 2,
        position: 1,
        entryAId: 'entry-1',
        entryBId: 'entry-5',
      }),
      buildFixture({
        id: 'fx-a-3',
        poolId: 'p-a',
        round: 3,
        position: 1,
        entryAId: 'entry-4',
        entryBId: 'entry-5',
      }),
      // Pool B: two players, so one fixture, and the draw is done.
      buildFixture({
        id: 'fx-b-1',
        poolId: 'p-b',
        round: 1,
        position: 1,
        entryAId: 'entry-2',
        entryBId: 'entry-3',
      }),
    ],
    ...overrides,
  })
}

/** One line of a pool's standings (ADR-0788): entry `entry-1`, sitting 1st with a clean
 * 2–0 record and a +3 game difference. `gameDifference` is `gamesWon - gamesLost`; the
 * factory keeps them consistent by default, but a test that wants an inconsistent wire
 * (to prove the client SHOWS the server's figure rather than recomputing it) overrides it
 * on its own. */
export function buildStandingRow(overrides: Partial<StandingRow> = {}): StandingRow {
  return {
    entryId: 'entry-1',
    rank: 1,
    played: 2,
    wins: 2,
    losses: 0,
    gamesWon: 4,
    gamesLost: 1,
    gameDifference: 3,
    ...overrides,
  }
}

/** One pool's standings — a **complete** three-player pool in finishing order:
 * `entry-1` (2–0) over `entry-4` (1–1) over `entry-5` (0–2). In the server's order, which
 * the view renders untouched (ADR-0788 — the order *is* the result), so a factory that
 * returned them sorted would let a re-sorting bug pass. */
export function buildPoolStandings(
  overrides: Partial<PoolStandings> = {},
): PoolStandings {
  return {
    poolId: 'p-a',
    complete: true,
    rows: [
      buildStandingRow({
        entryId: 'entry-1',
        rank: 1,
        wins: 2,
        losses: 0,
        gamesWon: 4,
        gamesLost: 1,
        gameDifference: 3,
      }),
      buildStandingRow({
        entryId: 'entry-4',
        rank: 2,
        wins: 1,
        losses: 1,
        gamesWon: 3,
        gamesLost: 3,
        gameDifference: 0,
      }),
      buildStandingRow({
        entryId: 'entry-5',
        rank: 3,
        wins: 0,
        losses: 2,
        gamesWon: 1,
        gamesLost: 4,
        gameDifference: -3,
      }),
    ],
    ...overrides,
  }
}

/** An event's results (ADR-0788): one **complete single pool** with a champion —
 * `entry-1`, who won it. Single-pool so `champion` is meaningful (a multi-pool event has
 * no single champion without a knockout stage yet — pass `pools` + `champion: null` for
 * that case). */
export function buildEventResults(
  overrides: Partial<EventResults> = {},
): EventResults {
  return {
    pools: [buildPoolStandings()],
    complete: true,
    champion: 'entry-1',
    ...overrides,
  }
}

/** A round-robin event **with results**: the drawn U1200 pool play (`buildDrawnEvent`)
 * projected forward to a finished single pool whose standings and champion the panel
 * renders. The entrant ids the results name (`entry-1`, `entry-4`, `entry-5`) are the ones
 * the drawn event lists, so the name join lands. */
export function buildStandingsEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  return buildEvent({
    id: 'ev-u1200',
    name: 'U1200 Singles',
    drawType: 'round-robin',
    maxPlayers: 24,
    entrants: buildEntrants(5),
    pools: [buildPool({ id: 'p-a', name: 'Pool A' })],
    results: buildEventResults(),
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
