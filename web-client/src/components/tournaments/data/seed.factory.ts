// Builders for the tournament domain objects. These are the shared factories
// the component quartets compose — each produces one realistic, internally
// consistent default (a published two-day open, an Open Singles event, etc.)
// that callers tweak via overrides.

import { DRAW_TYPE_CATALOGUE } from '@/mocks/factories/tournaments/tournament.factory'

import { parseDrawTypeCatalogue } from './draw-types'
import type { ConflictFixture, PlacementConflict, ScheduleSolve } from './solve'
import type {
  Address,
  DrawTypeOption,
  Entrant,
  EventEntryState,
  FinishesResults,
  FinishRow,
  Fixture,
  FixtureTime,
  Pool,
  PoolStandings,
  Predicate,
  StandingRow,
  StandingsResults,
  Tournament,
  TournamentEvent,
  TournamentTable,
} from './types'

/** The seeded venue address. Every part is optional in the domain (blank =
 * `''`), so the partial and wholly-blank cases are expressed by overriding
 * parts to `''` — `buildAddress({ venue: '', city: '', region: '' })` — rather
 * than by hand-rolling a second literal at each call site.
 *
 * ⚠️ A tournament with **no venue at all** is a different thing, and is not built
 * here: it is `buildTournament({ address: null })` (CONTEXT.md, "Venue"). An
 * all-blank `Address` is an address whose parts happen to be empty — a state the
 * server normalizes away on write — whereas `null` is the first-class "there is no
 * venue", which is also the only one of the two that carries no coordinates. */
export function buildAddress(overrides: Partial<Address> = {}): Address {
  return {
    venue: 'Berkeley TT Club',
    street: '2727 Milvia St',
    city: 'Berkeley',
    region: 'CA',
    postal: '94703',
    country: 'USA',
    // Server-geocoded on the read model (NOT NULL) — Berkeley, CA.
    latitude: 37.8715,
    longitude: -122.273,
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
    // Round-robin, and pooled to match — see the wire-side twin in
    // `mocks/factories/tournaments/tournament.factory.ts`. `DrawType` holds only the two
    // types the server can plan (ADR 20260726).
    drawType: 'round-robin',
    maxPlayers: 64,
    entryFee: 45,
    timezone: 'America/Chicago',
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
    // **No knockout stage to qualify for, so no qualifier count** (ADR 20260727) —
    // `null` is the only value a round-robin or single-elim event's draw settings admit,
    // and it is not "unset". Stated AFTER the spread because `Partial<…>` admits an
    // explicit `undefined` while the field is required-and-nullable (`number | null`) —
    // the same reason `entryState` is computed below rather than spread.
    qualifiersPerPool: overrides.qualifiersPerPool ?? null,
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
 * A **round-robin-then-knockout** event (ADR 20260727): two pools, and **two** qualifiers
 * out of each into the bracket.
 *
 * `qualifiersPerPool: 2` rather than the smallest legal `1`, deliberately. One is what a
 * planner falls back to when nobody tells it otherwise (`DEFAULT_QUALIFIERS_PER_POOL`,
 * `mocks/factories/tournaments/tournament.factory`), so a fixture built on it could not
 * tell "the director's count was threaded through" from "the default was taken" — the
 * exact mock/server mismatch that would cut a K=1 bracket for an event configured at K=2.
 * Two pools, likewise, because `P × K` is what sizes the bracket and a single pool would
 * make the product ambiguous between the two factors.
 */
export function buildRrThenKoEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  return buildEvent({
    id: 'ev-two-stage',
    name: 'Two-stage Singles',
    drawType: 'rr-then-ko',
    qualifiersPerPool: 2,
    maxPlayers: 32,
    entrants: buildEntrants(8),
    pools: [
      buildPool({ id: 'p-a', name: 'Pool A' }),
      buildPool({
        id: 'p-b',
        name: 'Pool B',
        slot: { date: '2026-06-13', start: '13:30', end: '17:00' },
      }),
    ],
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

/** Build a domain `FixtureTime` (ADR "tournament times are timezone-aware instants")
 * from a **naive venue wall-clock** stamp (`YYYY-MM-DDTHH:MM[:SS]`) — the convenient
 * shape a test writes. The seeds live in one venue frame, so the mock treats the
 * wall-clock as the UTC `instant` (deterministic tz-agnostic geometry), renders the
 * `localLabel` as a 12-hour clock, and tags it `CDT` — enough for both the display
 * labels and the bar geometry the schedule surfaces read. */
export function buildFixtureTime(naive: string): FixtureTime {
  const [date, time = '00:00'] = naive.split('T')
  const [h = 0, m = 0] = time.split(':').map(Number)
  const hh = String(h).padStart(2, '0')
  const mm = String(m).padStart(2, '0')
  const ampm = h < 12 ? 'AM' : 'PM'
  const h12 = h % 12 || 12
  return {
    instant: `${date}T${hh}:${mm}:00Z`,
    localLabel: `${h12}:${mm} ${ampm}`,
    tzAbbrev: 'CDT',
  }
}

/** A fixture time override: the domain `FixtureTime`, or the convenient naive
 * wall-clock string a test writes (coerced through `buildFixtureTime`), or `null`. */
type FixtureTimeInput = FixtureTime | string | null

function coerceFixtureTime(input: FixtureTimeInput): FixtureTime | null {
  if (input === null) return null
  return typeof input === 'string' ? buildFixtureTime(input) : input
}

/** `buildFixture` overrides, with the three placement times accepting a naive
 * wall-clock string (the shape tests write) as well as a full `FixtureTime`. */
type FixtureOverrides = Partial<
  Omit<Fixture, 'scheduledStart' | 'pinnedAt' | 'completedAt'>
> & {
  scheduledStart?: FixtureTimeInput
  pinnedAt?: FixtureTimeInput
  completedAt?: FixtureTimeInput
}

/** One fixture of a cut draw (ADR-0786): round 1, position 1 of `Pool A`, between the
 * first two entrants, undecided and not yet a match.
 *
 * Every `null` is a fact, so none of them is a default worth having *silently*: pass
 * `entryBId: null` for a **TBD** side (never a bye — a bye is the ABSENCE of a fixture),
 * `poolId: null` for an un-pooled (knockout) fixture. Placement (ADR-0790) defaults
 * empty: `tableId: null` unassigned, `scheduledStart: null` unscheduled. The three
 * placement times take a naive wall-clock string for convenience (`buildFixtureTime`
 * shapes it into the `FixtureTime` the wire now sends) or a full `FixtureTime`. */
export function buildFixture(overrides: FixtureOverrides = {}): Fixture {
  const { scheduledStart, pinnedAt, completedAt, ...rest } = overrides
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
    tableId: null,
    callNotifiedCount: 0,
    ...rest,
    // The placement times last, after `rest`, so the naive-string coercion always
    // wins over a raw override of the same key.
    scheduledStart: coerceFixtureTime(scheduledStart ?? null),
    // Uncalled (ADR "the schedule is solved, the call is pinned"): the placement —
    // when one is set — is still an estimate, and nobody has been notified.
    pinnedAt: coerceFixtureTime(pinnedAt ?? null),
    // Not decided yet: no actual completion time.
    completedAt: coerceFixtureTime(completedAt ?? null),
  }
}

/** One row of the tournament's solve ledger, in the domain's spelling — by default
 * a **finished, successful** manual run (`succeeded`/`optimal`, sub-second, nine
 * fixtures placed). Internally consistent for that status: every stage reached, so
 * every stage-marking field set. A test that wants an earlier stage overrides the
 * status AND nulls the fields that stage has not reached — each `null` is a fact
 * about how far the run got. */
export function buildScheduleSolve(
  overrides: Partial<ScheduleSolve> = {},
): ScheduleSolve {
  return {
    id: 'solve-1',
    trigger: 'manual',
    status: 'succeeded',
    verdict: 'optimal',
    requestedAt: '2026-06-13T09:00:00Z',
    startedAt: '2026-06-13T09:00:01Z',
    finishedAt: '2026-06-13T09:00:02Z',
    wallTimeMs: 850,
    fixturesPlaced: 9,
    fixturesPinned: 0,
    overrunning: false,
    error: null,
    // A succeeded run has no infeasibility reasons; the list is always present
    // (`[]` off the infeasible path). An infeasible fixture overrides this — e.g.
    // `infeasibilityReasons: [{ kind: 'past_window', date: '…' }]`.
    infeasibilityReasons: [],
    // A clean board has no overlapping in-progress matches; the list is always
    // present (`[]` on a clean board) and orthogonal to the verdict — a fixture
    // proving the caution passes a `placementConflicts` override on ANY status.
    placementConflicts: [],
    ...overrides,
  }
}

/** One in-progress match caught in a placement conflict, named by its matchup —
 * `crafty` vs `spiked` by default. A conflict fixture a test wants a specific
 * matchup for overrides the two player names. */
export function buildConflictFixture(
  overrides: Partial<ConflictFixture> = {},
): ConflictFixture {
  return {
    fixtureId: 'fx-conflict-1',
    playerA: 'crafty',
    playerB: 'spiked',
    ...overrides,
  }
}

/** A **table** placement conflict (ADR "overlapping-in-progress-matches-are-
 * tolerated-and-reported"): two in-progress matches — `crafty-vs-spiked` and
 * `dazed-vs-confused` — recorded on the same table (`Table 1`). */
export function buildTableConflict(
  overrides: Partial<Extract<PlacementConflict, { kind: 'table_conflict' }>> = {},
): PlacementConflict {
  return {
    kind: 'table_conflict',
    tableLabel: 'Table 1',
    fixtures: [
      buildConflictFixture({ fixtureId: 'fx-conflict-a', playerA: 'crafty', playerB: 'spiked' }),
      buildConflictFixture({ fixtureId: 'fx-conflict-b', playerA: 'dazed', playerB: 'confused' }),
    ],
    ...overrides,
  }
}

/** A **player** placement conflict: two in-progress matches sharing a human
 * (`spiked-frigatebird`) — `crafty-vs-spiked-frigatebird` and
 * `spiked-frigatebird-vs-nimble`. */
export function buildPlayerConflict(
  overrides: Partial<Extract<PlacementConflict, { kind: 'player_conflict' }>> = {},
): PlacementConflict {
  return {
    kind: 'player_conflict',
    playerName: 'spiked-frigatebird',
    fixtures: [
      buildConflictFixture({
        fixtureId: 'fx-conflict-c',
        playerA: 'crafty',
        playerB: 'spiked-frigatebird',
      }),
      buildConflictFixture({
        fixtureId: 'fx-conflict-d',
        playerA: 'spiked-frigatebird',
        playerB: 'nimble',
      }),
    ],
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
  overrides: Partial<StandingsResults> = {},
): StandingsResults {
  return {
    kind: 'standings',
    pools: [buildPoolStandings()],
    complete: true,
    champion: 'entry-1',
    ...overrides,
  }
}

/** One line of a single-elimination event's finishes (ADR-0785): entry `entry-1`, finishing
 * 1st (the champion), never eliminated. A same-round tie is built by giving two rows the same
 * `position` (e.g. the two semifinal losers both `position: 3`). */
export function buildFinishRow(overrides: Partial<FinishRow> = {}): FinishRow {
  return {
    entryId: 'entry-1',
    position: 1,
    eliminatedInRound: null,
    ...overrides,
  }
}

/** A single-elimination event's results — a **complete** four-entrant bracket's finishes, in
 * the server's order: `entry-1` champion (1st), `entry-2` runner-up (2nd), and the two
 * semifinal losers `entry-3`/`entry-4` **tied 3rd**. The champion is `entry-1`. A partial
 * (live) bracket is built by overriding `finishes` with only the entrants placed so far and
 * `complete: false` / `champion: null`. */
export function buildFinishesResults(
  overrides: Partial<FinishesResults> = {},
): FinishesResults {
  return {
    kind: 'finishes',
    finishes: [
      buildFinishRow({ entryId: 'entry-1', position: 1, eliminatedInRound: null }),
      buildFinishRow({ entryId: 'entry-2', position: 2, eliminatedInRound: 2 }),
      buildFinishRow({ entryId: 'entry-3', position: 3, eliminatedInRound: 1 }),
      buildFinishRow({ entryId: 'entry-4', position: 3, eliminatedInRound: 1 }),
    ],
    complete: true,
    champion: 'entry-1',
    ...overrides,
  }
}

/** A single-elimination event **with finishes**: an Open Singles bracket projected forward to
 * a decided four-entrant field whose placement list and champion the panel renders. The
 * entrant ids the finishes name (`entry-1`…`entry-4`) are the ones the event lists, so the
 * name join lands. */
export function buildFinishesEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  return buildEvent({
    id: 'ev-single-elim',
    name: 'Championship Singles',
    drawType: 'single-elim',
    maxPlayers: 16,
    entrants: buildEntrants(4),
    pools: [],
    results: buildFinishesResults(),
    ...overrides,
  })
}

/**
 * A fixture event's own **standings block**, narrowed — what `ResultsPanel` hands
 * `eventStandings` after its switch on `results.kind`.
 *
 * A test reasons in whole events (the results and the entrants they join against travel
 * together), but the selector and the panel now take the block, so this is the bridge. It
 * **throws** rather than returning `null`: a fixture that is not a standings event is a
 * mis-built test, and it should say so at the call site instead of quietly yielding a view
 * of nothing.
 */
export function standingsResultsOf(event: TournamentEvent): StandingsResults {
  const results = event.results
  if (results === null || results.kind !== 'standings') {
    throw new Error(
      `Fixture event '${event.id}' has no standings block (results: ${results?.kind ?? 'null'}). Build it with buildStandingsEvent().`,
    )
  }
  return results
}

/**
 * A fixture event's own **finishes block**, narrowed — the `finishes` twin of
 * `standingsResultsOf`, and throwing for the same reason.
 */
export function finishesResultsOf(event: TournamentEvent): FinishesResults {
  const results = event.results
  if (results === null || results.kind !== 'finishes') {
    throw new Error(
      `Fixture event '${event.id}' has no finishes block (results: ${results?.kind ?? 'null'}). Build it with buildFinishesEvent().`,
    )
  }
  return results
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

/** The draw-type catalogue **as the server serves it** (ADR 20260726): both seeded
 * rows, labelled with the migration's copy, in `display_order` — round robin first.
 *
 * A fixture of a *response*, not a menu this client authors. The labels are therefore
 * NOT written here: they are the server's seed copy, which lives verbatim in
 * `DRAW_TYPE_CATALOGUE` (`src/mocks/factories/tournaments/tournament.factory.ts`,
 * itself a copy of the migration's `DRAW_TYPE_SEED`) — so a component test's picker
 * holds the words a director really sees, from one place. Run through the real
 * `parseDrawTypeCatalogue`, so this fixture is a *parsed* payload rather than an
 * option list assembled by hand, and the parser is exercised on the way (the `?? []`
 * is unreachable — the parser answers `null` only for a nullish catalogue, and
 * `DRAW_TYPE_CATALOGUE` is an array).
 *
 * ⚠️ Never assert the picker's contents against **this** fixture alone — that is a
 * mock agreeing with itself. The claim worth proving is that the picker follows
 * *whatever* catalogue arrives, which is what the hand-written catalogues in
 * `basics-section.test.tsx` exercise. */
export function buildDrawTypes(): DrawTypeOption[] {
  return parseDrawTypeCatalogue(DRAW_TYPE_CATALOGUE) ?? []
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
    // Venued by default. `buildTournament({ address: null })` is the venue-less
    // tournament — no venue line, no pin, no map anywhere it is rendered.
    address: buildAddress(),
    tableIds: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'],
    events: [buildEvent()],
    // NO SOLVE YET — the designed state every tournament is born in. A fixture that
    // wants a row on the strip passes a `buildScheduleSolve()` override.
    latestScheduleSolve: null,
    // The DETAIL payload's catalogue, because this builds a tournament as a page holds
    // one. A list-row fixture passes `drawTypes: null` — the shape that route sends.
    drawTypes: buildDrawTypes(),
    ...overrides,
  }
}
