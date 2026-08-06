// Builders for the tournament domain objects. These are the shared factories
// the component quartets compose — each produces one realistic, internally
// consistent default (a published two-day open, an Open Singles event, etc.)
// that callers tweak via overrides.

import { DRAW_TYPE_CATALOGUE } from '@/mocks/factories/tournaments/tournament.factory'

import { parseDrawTypeCatalogue } from './draw-types'
import type { ConflictFixture, PlacementConflict, ScheduleSolve } from './solve'
import { keepPools } from './pool-entries'
import type {
  Address,
  DrawTypeOption,
  EditedEvent,
  Entrant,
  EventEntryState,
  FinishesResults,
  FinishRow,
  Fixture,
  FixtureTime,
  Pool,
  PoolEntry,
  PoolStandings,
  Predicate,
  StandingRow,
  StandingsResults,
  StandingsThenFinishesResults,
  SwissStandingsResults,
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

/** A four-table morning pool, **first** in its event (`position: 0`).
 *
 * `position` is 0-based and server-assigned from the pool's index in the list a write
 * sent, so a fixture with several pools must number them 0, 1, 2 … in the order it means
 * them — and must NOT let them collide. Nothing orders by id (`poolsInOrder`,
 * `data/helpers`), so a second pool left on the default `0` is not "second", it is tied
 * for first and lands wherever a stable sort leaves it. */
export function buildPool(overrides: Partial<Pool> = {}): Pool {
  return {
    id: 'p-1',
    name: 'Pool A',
    slot: { date: '2026-06-13', start: '09:00', end: '12:30' },
    tableIds: ['t1', 't2', 't3', 't4'],
    position: 0,
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
    // `null` is the only value a round-robin, single-elim or swiss event's draw settings
    // admit, and it is not "unset". Stated AFTER the spread because `Partial<…>` admits an
    // explicit `undefined` while the field is required-and-nullable (`number | null`) —
    // the same reason `entryState` is computed below rather than spread.
    qualifiersPerPool: overrides.qualifiersPerPool ?? null,
    // **No chosen round count** either (the swiss ADR) — a round-robin's rounds are dealt by
    // the circle method and a bracket's depth follows from the field, so `null` is the only
    // value those draw types' settings admit. Stated AFTER the spread for the same reason
    // the qualifier count is: `Partial<…>` admits an explicit `undefined` while the field is
    // required-and-nullable (`number | null`).
    rounds: overrides.rounds ?? null,
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

/**
 * The same event as the **editor** would hand it back with nothing about its pools
 * changed: every stored pool cited by the id the server minted (`keepPools`,
 * `data/pool-entries`).
 *
 * This is the shape the write mappers take (`EditedEvent`), and building it through the
 * production constructor is the point: a test that hand-wrote `kind: 'kept'` entries
 * could keep passing after `keepPools` stopped citing ids, which is the exact regression
 * — a no-op diff read as "remove every pool" — that shape exists to prevent.
 *
 * Pass `pools` to state a real edit: `[...keepPools(event.pools), addedPool({…})]` adds
 * one, a shorter list removes one.
 */
export function buildEditedEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered' | 'pools'>> & {
    pools?: PoolEntry[]
  } = {},
): EditedEvent {
  const { pools, ...eventOverrides } = overrides
  // `pools: undefined` still triggers `asEditedEvent`'s own default (`keepPools`)
  // — passing it through rather than repeating the default here is what keeps the
  // no-op-diff default in the one place `asEditedEvent` already states it.
  return asEditedEvent(buildEvent(eventOverrides), pools)
}

/** One read event, re-expressed as the editor's no-op diff — `buildEditedEvent` for a
 * test that already holds the event it means. */
export function asEditedEvent(
  event: TournamentEvent,
  pools: PoolEntry[] = keepPools(event.pools),
): EditedEvent {
  return { ...event, pools }
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
 * `qualifiersPerPool: 2` rather than the smallest legal `1`, deliberately. One is the
 * value any dropped-count bug lands on — the smallest legal K, and the shape of a bracket
 * cut for a count nobody supplied — so a fixture built on it could not tell "the
 * director's count was threaded through" from "something substituted the minimum": the
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
        // SECOND, said out loud. Pool B does not follow Pool A because it is written
        // second or because `p-b` sorts after `p-a` — nothing reads either (`poolsInOrder`,
        // `data/helpers`). Left on the factory's default `0` it would tie with Pool A.
        position: 1,
      }),
    ],
    ...overrides,
  })
}

/**
 * A **swiss** event (ADR "swiss pre-cuts every round and pairs each one on advance"): eight
 * entrants over **three** rounds, and **no pools at all**.
 *
 * `rounds: 3` rather than the smallest legal `1`, deliberately, and for the reason
 * `buildRrThenKoEvent` gives about its qualifier count: `1` is where any dropped-setting
 * bug lands, so a fixture built on it could not tell "the director's R was threaded
 * through" from "something substituted the minimum". It is also a legal R for this field —
 * the cut refuses `R > n - 1 + n % 2`, and 3 is comfortably under 7.
 *
 * `pools: []` is the format, not an omission: swiss ranks the whole field in one table, so
 * an event carrying pools would be describing a shape the draw does not have.
 */
export function buildSwissEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  return buildEvent({
    id: 'ev-swiss',
    name: 'Swiss Singles',
    drawType: 'swiss',
    rounds: 3,
    maxPlayers: 32,
    entrants: buildEntrants(8),
    pools: [],
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
        // SECOND, said out loud. Pool B does not follow Pool A because it is written
        // second or because `p-b` sorts after `p-a` — nothing reads either (`poolsInOrder`,
        // `data/helpers`). Left on the factory's default `0` it would tie with Pool A.
        position: 1,
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

/**
 * A **swiss** event whose draw is cut: six entrants over three rounds, so `3 × ⌊6/2⌋ = 9`
 * fixtures — **all of them written at the cut**, which is the format (ADR "swiss pre-cuts
 * every round and pairs each one on advance").
 *
 * Round 1 is paired top-half-against-bottom-half from the draw order, exactly as
 * `SwissStrategy.plan_initial` seeds it (`entry-1 v entry-4`, `entry-2 v entry-5`,
 * `entry-3 v entry-6`). Rounds 2 and 3 carry **both sides null** — TBD, waiting on
 * `advance()`, and *not* byes.
 *
 * Every fixture is `poolId: null`, and that is the trap this fixture exists to catch: it is
 * byte-identical in shape to a single-elimination bracket, so a panel routing on the null
 * renders this as one. Only the DRAW TYPE tells them apart.
 *
 * `rounds: 3` over six entrants is legal at the cut (`R <= n - 1 + n % 2`), so nothing here
 * is a shape the server would have refused.
 */
export function buildSwissDrawnEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  const pairing = (round: number, position: number, a: string | null, b: string | null) =>
    buildFixture({
      id: `fx-sw-r${round}-p${position}`,
      poolId: null,
      round,
      position,
      entryAId: a,
      entryBId: b,
    })
  return buildSwissEvent({
    entrants: buildEntrants(6),
    rounds: 3,
    fixtures: [
      pairing(1, 1, 'entry-1', 'entry-4'),
      pairing(1, 2, 'entry-2', 'entry-5'),
      pairing(1, 3, 'entry-3', 'entry-6'),
      pairing(2, 1, null, null),
      pairing(2, 2, null, null),
      pairing(2, 3, null, null),
      pairing(3, 1, null, null),
      pairing(3, 2, null, null),
      pairing(3, 3, null, null),
    ],
    ...overrides,
  })
}

/**
 * The same swiss event **one round in**: round 1 played out and round 2 paired by
 * `advance()` from the standings, round 3 still waiting.
 *
 * The discriminating fixture for "is this round forthcoming?". On the cut-fresh event above
 * the answer tracks the round number exactly — round 1 paired, 2 and 3 not — so a renderer
 * that asked `round > 1` instead of asking the *sides* would pass on it and be wrong for
 * the rest of the tournament. Here the two disagree: **round 2 is paired**, and it is what
 * the ordinary state of a running swiss event looks like.
 *
 * Round 2's pairings are by score, not by the round-1 bracket: the round-1 winners
 * (`entry-1`, `entry-2`, `entry-3`) meet each other, as swiss pairs like with like.
 */
export function buildSwissMidEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  const cut = buildSwissDrawnEvent()
  return buildSwissDrawnEvent({
    fixtures: [
      ...cut.fixtures.slice(0, 3),
      buildFixture({
        id: 'fx-sw-r2-p1',
        poolId: null,
        round: 2,
        position: 1,
        entryAId: 'entry-1',
        entryBId: 'entry-2',
      }),
      buildFixture({
        id: 'fx-sw-r2-p2',
        poolId: null,
        round: 2,
        position: 2,
        entryAId: 'entry-3',
        entryBId: 'entry-4',
      }),
      buildFixture({
        id: 'fx-sw-r2-p3',
        poolId: null,
        round: 2,
        position: 3,
        entryAId: 'entry-5',
        entryBId: 'entry-6',
      }),
      ...cut.fixtures.slice(6),
    ],
    ...overrides,
  })
}

/**
 * A swiss event with an **ODD** field whose draw is cut: **seven** entrants over three
 * rounds, so `3 × ⌊7/2⌋ = 9` fixtures and one entrant sitting out every round.
 *
 * The fixture the bye is about. Round 1 seats `entry-1`…`entry-6` (top half against bottom
 * half, exactly as `plan_initial` deals it) and `entry-7` is in **no fixture at all** —
 * because a bye is the ABSENCE of a row (ADR-0786), never a row with a null side. That
 * absence is precisely why the seventh entrant appeared nowhere in the draw: they are
 * derivable from the event and from nothing on the fixture.
 *
 * `rounds: 3` is legal for this field, and comfortably so — an odd field of 7 can play 7
 * rounds without a rematch (`R <= n - 1 + n % 2`).
 *
 * The fixtures are the six-entrant cut's, unchanged, because they are the same nine rows:
 * `⌊7/2⌋` is also 3, and top-half-against-bottom-half over seven names deals `entry-1 v
 * entry-4`, `entry-2 v entry-5`, `entry-3 v entry-6` exactly as over six. The one
 * difference is the seventh entrant, and the whole point is that no fixture mentions them.
 */
export function buildSwissOddDrawnEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  return buildSwissDrawnEvent({
    id: 'ev-swiss-odd',
    entrants: buildEntrants(7),
    ...overrides,
  })
}

/**
 * The odd-field swiss event **one round in**: round 2 paired by `advance()`, byeing a
 * DIFFERENT entrant (`entry-1`, who won round 1 and now draws the bye) while `entry-7` —
 * round 1's bye — plays.
 *
 * The discriminating fixture for the bye, and it is the same trick `buildSwissMidEvent`
 * plays on `isPaired`: with only the cut-fresh event above, "who sits out this round?" has
 * one answer for the whole draw, so an implementation that subtracted against **round 1's**
 * fixtures for every round would pass. Here the two disagree.
 */
export function buildSwissOddMidEvent(
  // `fixtures` is deliberately NOT overridable: this event *is* its round-2 pairing, and a
  // caller who replaced the list — to add a round-3 pairing, say — would silently get the
  // cut-fresh draw back, since a spread override lands after the fixtures below. Want a
  // different draw? Build it from `buildSwissOddDrawnEvent`.
  overrides: Partial<Omit<TournamentEvent, 'entered' | 'fixtures'>> = {},
): TournamentEvent {
  const cut = buildSwissOddDrawnEvent()
  const pairing = (position: number, a: string, b: string) =>
    buildFixture({
      id: `fx-sw-r2-p${position}`,
      poolId: null,
      round: 2,
      position,
      entryAId: a,
      entryBId: b,
    })
  return buildSwissOddDrawnEvent({
    ...overrides,
    fixtures: [
      ...cut.fixtures.filter((f) => f.round === 1),
      pairing(1, 'entry-2', 'entry-3'),
      pairing(2, 'entry-4', 'entry-5'),
      pairing(3, 'entry-6', 'entry-7'),
      ...cut.fixtures.filter((f) => f.round === 3),
    ],
  })
}

/**
 * An **rr-then-ko** event whose draw is cut: both pools' round-robin fixtures **and** the
 * knockout bracket, all in one stroke (ADR 20260727) — the bracket entirely TBD-sided,
 * because nobody has qualified yet.
 *
 * The regression pin for the routing. Its knockout fixtures are `poolId: null`, exactly as
 * a swiss draw's are, and they must keep rendering as a **bracket**: for this draw type the
 * null really is the stage discriminator, which is the meaning the swiss fix must not
 * disturb.
 */
export function buildTwoStageDrawnEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  return buildRrThenKoEvent({
    entrants: buildEntrants(8),
    fixtures: [
      // The pool stage — one fixture per pool is enough to prove the pools still render
      // above the bracket; the snake's full circle is `buildDrawnEvent`'s business.
      buildFixture({
        id: 'fx-pa-1',
        poolId: 'p-a',
        round: 1,
        position: 1,
        entryAId: 'entry-1',
        entryBId: 'entry-3',
      }),
      buildFixture({
        id: 'fx-pb-1',
        poolId: 'p-b',
        round: 1,
        position: 1,
        entryAId: 'entry-2',
        entryBId: 'entry-4',
      }),
      // The knockout stage: `P × K` = 2 × 2 = 4 slots, so two semifinals and a final, every
      // side TBD until the pools decide their qualifiers.
      buildFixture({
        id: 'fx-ko-r1-p1',
        poolId: null,
        round: 1,
        position: 1,
        entryAId: null,
        entryBId: null,
      }),
      buildFixture({
        id: 'fx-ko-r1-p2',
        poolId: null,
        round: 1,
        position: 2,
        entryAId: null,
        entryBId: null,
      }),
      buildFixture({
        id: 'fx-ko-r2-p1',
        poolId: null,
        round: 2,
        position: 1,
        entryAId: null,
        entryBId: null,
      }),
    ],
    ...overrides,
  })
}

/**
 * A **single-elimination** event whose draw is cut: four entrants, two semifinals with
 * their seeds named and a TBD final.
 *
 * The other regression pin. Un-pooled like a swiss draw and like the knockout stage above,
 * and it must keep rendering as a bracket.
 */
export function buildBracketDrawnEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  return buildEvent({
    id: 'ev-bracket',
    name: 'Championship Singles',
    drawType: 'single-elim',
    entrants: buildEntrants(4),
    // A bracket is un-pooled — the event's pools are not consulted at all (ADR-0786).
    pools: [],
    fixtures: [
      buildFixture({
        id: 'fx-se-r1-p1',
        poolId: null,
        round: 1,
        position: 1,
        entryAId: 'entry-1',
        entryBId: 'entry-4',
      }),
      buildFixture({
        id: 'fx-se-r1-p2',
        poolId: null,
        round: 1,
        position: 2,
        entryAId: 'entry-3',
        entryBId: 'entry-2',
      }),
      buildFixture({
        id: 'fx-se-r2-p1',
        poolId: null,
        round: 2,
        position: 1,
        entryAId: null,
        entryBId: null,
      }),
    ],
    ...overrides,
  })
}

/** How many pools `buildTenPools` builds — ten, because ten is the smallest count at
 * which a legacy client-minted id (`p-10-…`) sorts into the middle of the single digits.
 * Nine pools would order identically by id and by position, and prove nothing. */
const TEN = 10

/**
 * **Ten pools whose ids sort differently from their positions** — the fixture the whole
 * ordering rule is about, and the only pool fixture that can falsify it.
 *
 * The ids reproduce the legacy shape the editor used to mint before pool ids became
 * server-minted UUIDs (`genId('p')` — `p-1-<ts>`, `p-2-<ts>` … `p-10-<ts>`, one
 * timestamp for the burst), and as strings `p-10-` falls between `p-1-` and `p-2-`. So
 * anything that sorted these by id renders **1, 10, 2, 3 … 9** — which is not a
 * hypothetical: it is exactly what a ten-pool event's draw did before pools carried a
 * position.
 *
 * They are returned **in that wrong order on purpose**, positions 0–9 telling the truth
 * underneath. A fixture handed over already sorted cannot tell "orders by position" from
 * "inherited the order it was given", so it would keep passing after the sort was
 * deleted. This one reds for both.
 *
 * Each pool gets its own table and its own half-hour window, so ten pools raise no
 * double-booking diagnostic — the claim under test is the order, and a warning banner
 * would be noise inside it.
 */
export function buildTenPools(): Pool[] {
  const inPositionOrder = Array.from({ length: TEN }, (_, i) => {
    const n = i + 1
    return buildPool({
      // The legacy `genId('p')` shape: index, then the shared base-36 timestamp.
      id: `p-${n}-mkq1x`,
      name: `Pool ${n}`,
      position: i,
      tableIds: [`t${n}`],
      slot: {
        date: '2026-06-13',
        start: `${String(9 + i).padStart(2, '0')}:00`,
        end: `${String(9 + i).padStart(2, '0')}:30`,
      },
    })
  })
  // Sorted by **id**, by codepoint (not `localeCompare`, which collates digits and
  // punctuation by locale rules and would quietly stop reproducing the bug).
  return [...inPositionOrder].sort((a, b) => (a.id < b.id ? -1 : 1))
}

/** The ten pools' names in **position** order — `Pool 1` … `Pool 10`. What every surface
 * that lays them out must show. */
export const TEN_POOLS_BY_POSITION = Array.from(
  { length: TEN },
  (_, i) => `Pool ${i + 1}`,
)

/** The same ten names in **id** order — `Pool 1`, `Pool 10`, `Pool 2` … The wrong answer,
 * named, so a test can assert it is not the one being given. */
export const TEN_POOLS_BY_ID = buildTenPools().map((p) => p.name)

/**
 * A **drawn** ten-pool event: `buildTenPools`, each pool holding one fixture between two
 * entrants of its own (20 entrants, `player.1`…`player.20`).
 *
 * One fixture per pool because `drawState` renders only the pools the draw actually used
 * — a pool with no fixtures is not part of the draw and would simply vanish, taking the
 * ordering claim with it. Two players a pool is the smallest thing that makes a fixture.
 */
export function buildTenPoolDrawnEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  const pools = buildTenPools()
  return buildEvent({
    id: 'ev-ten-pools',
    name: 'Ten-pool Singles',
    drawType: 'round-robin',
    maxPlayers: 32,
    entrants: buildEntrants(TEN * 2),
    pools,
    // Built off the pools **in position order**, so the fixture list is in the server's
    // own order (pool → round → position) and the panel is never handed a hint.
    fixtures: [...pools]
      .sort((a, b) => a.position - b.position)
      .map((pool, i) =>
        buildFixture({
          id: `fx-${pool.id}`,
          poolId: pool.id,
          round: 1,
          position: 1,
          entryAId: `entry-${i * 2 + 1}`,
          entryBId: `entry-${i * 2 + 2}`,
        }),
      ),
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
 * A **two-stage** event's results (ADR 20260727) — a played-out `rr-then-ko`: two pools
 * decided, the bracket run to a final, one champion.
 *
 * The numbers are arranged around the claim the format turns on: **the champion is the
 * bracket's, never a pool's.** `entry-2` wins the final, and `entry-2` tops NO pool —
 * `entry-5` leads Pool A and `entry-3` leads Pool B, and both of them lose their semifinal
 * (they are the two tied 3rd). A fixture whose champion also happened to top the first
 * standings table could not tell a banner that reads the bracket from one that reads the
 * standings, and that is exactly the bug worth catching.
 *
 * The finishes follow single-elimination's own shape, unchanged: 1st, 2nd, then the two
 * same-round losers **tied 3rd**. A mid-flight event is built by overriding
 * `complete: false`, `champion: null` and a `finishes` list holding only what the bracket
 * has settled (see `buildMidFlightTwoStageResults`).
 */
export function buildTwoStageResults(
  overrides: Partial<StandingsThenFinishesResults> = {},
): StandingsThenFinishesResults {
  return {
    kind: 'standings_then_finishes',
    pools: [
      buildPoolStandings({
        poolId: 'p-a',
        complete: true,
        rows: [
          buildStandingRow({ entryId: 'entry-5', rank: 1, played: 3, wins: 3, losses: 0, gamesWon: 6, gamesLost: 1, gameDifference: 5 }),
          buildStandingRow({ entryId: 'entry-1', rank: 2, played: 3, wins: 2, losses: 1, gamesWon: 5, gamesLost: 2, gameDifference: 3 }),
          buildStandingRow({ entryId: 'entry-4', rank: 3, played: 3, wins: 1, losses: 2, gamesWon: 2, gamesLost: 5, gameDifference: -3 }),
          buildStandingRow({ entryId: 'entry-8', rank: 4, played: 3, wins: 0, losses: 3, gamesWon: 1, gamesLost: 6, gameDifference: -5 }),
        ],
      }),
      buildPoolStandings({
        poolId: 'p-b',
        complete: true,
        rows: [
          buildStandingRow({ entryId: 'entry-3', rank: 1, played: 3, wins: 2, losses: 1, gamesWon: 5, gamesLost: 3, gameDifference: 2 }),
          buildStandingRow({ entryId: 'entry-2', rank: 2, played: 3, wins: 2, losses: 1, gamesWon: 4, gamesLost: 4, gameDifference: 0 }),
          buildStandingRow({ entryId: 'entry-6', rank: 3, played: 3, wins: 1, losses: 2, gamesWon: 4, gamesLost: 4, gameDifference: 0 }),
          buildStandingRow({ entryId: 'entry-7', rank: 4, played: 3, wins: 1, losses: 2, gamesWon: 3, gamesLost: 5, gameDifference: -2 }),
        ],
      }),
    ],
    finishes: [
      buildFinishRow({ entryId: 'entry-2', position: 1, eliminatedInRound: null }),
      buildFinishRow({ entryId: 'entry-1', position: 2, eliminatedInRound: 2 }),
      buildFinishRow({ entryId: 'entry-5', position: 3, eliminatedInRound: 1 }),
      buildFinishRow({ entryId: 'entry-3', position: 3, eliminatedInRound: 1 }),
    ],
    complete: true,
    champion: 'entry-2',
    ...overrides,
  }
}

/** The **mid-flight** two-stage read: the same pools, all decided, and a bracket one match
 * from home — the final seated and unplayed. So `complete` is `false` (both stages decided
 * is the bar, and one is not), `champion` is `null`, and the finishes list **starts at
 * position 3**: the two beaten semifinalists are the only entrants the bracket has placed,
 * and 1st and 2nd do not exist yet. It is the state the seed's `ev-shield` is in, and the
 * one a partial render must survive. */
export function buildMidFlightTwoStageResults(
  overrides: Partial<StandingsThenFinishesResults> = {},
): StandingsThenFinishesResults {
  return buildTwoStageResults({
    complete: false,
    champion: null,
    finishes: [
      buildFinishRow({ entryId: 'entry-5', position: 3, eliminatedInRound: 1 }),
      buildFinishRow({ entryId: 'entry-3', position: 3, eliminatedInRound: 1 }),
    ],
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

/**
 * A fixture event's own **two-stage block**, narrowed — the `standings_then_finishes` twin
 * of the two above, and throwing for the same reason.
 */
export function twoStageResultsOf(
  event: TournamentEvent,
): StandingsThenFinishesResults {
  const results = event.results
  if (results === null || results.kind !== 'standings_then_finishes') {
    throw new Error(
      `Fixture event '${event.id}' has no two-stage block (results: ${results?.kind ?? 'null'}). Build it with buildTwoStageEvent().`,
    )
  }
  return results
}

/** A **two-stage** (`rr-then-ko`) event **with results**: the two-pool event
 * `buildRrThenKoEvent` seeds, played out to a champion (`buildTwoStageResults`). Its eight
 * entrants (`entry-1`…`entry-8`) are the ones both stages name, so every id joins to a
 * username; its two pools (`p-a`, `p-b`) are the ones the standings name, so both tables
 * title themselves.
 *
 * The mid-flight state — pools done, final unplayed, no champion — is
 * `buildTwoStageEvent({ results: buildMidFlightTwoStageResults() })`. */
export function buildTwoStageEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  return buildRrThenKoEvent({
    results: buildTwoStageResults(),
    ...overrides,
  })
}

/**
 * A fixture event's own **swiss standings block**, narrowed — the `swiss_standings` twin
 * of the three above, and throwing for the same reason.
 */
export function swissStandingsResultsOf(
  event: TournamentEvent,
): SwissStandingsResults {
  const results = event.results
  if (results === null || results.kind !== 'swiss_standings') {
    throw new Error(
      `Fixture event '${event.id}' has no swiss standings block (results: ${results?.kind ?? 'null'}). Build it with buildSwissStandingsEvent().`,
    )
  }
  return results
}

/**
 * A **swiss** event's results (the swiss ADR): **one complete table over the whole field**,
 * four entrants deep, with `entry-1` on top and crowned.
 *
 * No pools, which is the whole shape: a swiss ranks everybody against everybody. The ranks
 * are distinct and the numbers descend with them, so a panel that re-sorted — or a selector
 * that lost the order — would show a visibly different table. The live state (rounds still
 * to play) is `buildSwissStandingsResults({ complete: false, champion: null })`.
 */
export function buildSwissStandingsResults(
  overrides: Partial<SwissStandingsResults> = {},
): SwissStandingsResults {
  return {
    kind: 'swiss_standings',
    rows: [
      buildStandingRow({
        entryId: 'entry-1',
        rank: 1,
        played: 3,
        wins: 3,
        losses: 0,
        gamesWon: 9,
        gamesLost: 2,
        gameDifference: 7,
      }),
      buildStandingRow({
        entryId: 'entry-2',
        rank: 2,
        played: 3,
        wins: 2,
        losses: 1,
        gamesWon: 7,
        gamesLost: 5,
        gameDifference: 2,
      }),
      buildStandingRow({
        entryId: 'entry-3',
        rank: 3,
        played: 3,
        wins: 1,
        losses: 2,
        gamesWon: 5,
        gamesLost: 7,
        gameDifference: -2,
      }),
      buildStandingRow({
        entryId: 'entry-4',
        rank: 4,
        played: 3,
        wins: 0,
        losses: 3,
        gamesWon: 2,
        gamesLost: 9,
        gameDifference: -7,
      }),
    ],
    complete: true,
    champion: 'entry-1',
    ...overrides,
  }
}

/** A **swiss** event **with results**: the pool-less swiss event `buildSwissEvent` seeds,
 * played out to a champion. Its entrants (`entry-1`…`entry-8`) include every id the table
 * names, so every row joins to a username. */
export function buildSwissStandingsEvent(
  overrides: Partial<Omit<TournamentEvent, 'entered'>> = {},
): TournamentEvent {
  return buildSwissEvent({
    results: buildSwissStandingsResults(),
    ...overrides,
  })
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
