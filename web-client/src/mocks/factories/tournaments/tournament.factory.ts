import type { components } from '@/api/schema'
import { FORTYMM_LEAGUE_ID } from '@/mocks/factories/players/player-league.factory'

type TournamentDetailRead = components['schemas']['TournamentDetailRead']
type TournamentEventRead = components['schemas']['TournamentEventRead']
type TournamentEntrantRead = components['schemas']['TournamentEntrantRead']
type TournamentFixtureRead = components['schemas']['TournamentFixtureRead']
type TournamentTable = components['schemas']['TournamentTable']
type EventResultsRead = components['schemas']['EventResultsRead']
type PoolStandingsRead = components['schemas']['PoolStandingsRead']
type StandingRowRead = components['schemas']['StandingRowRead']
type ScheduleSolveRead = components['schemas']['ScheduleSolveRead']
type AdminScheduleSolveRead = components['schemas']['AdminScheduleSolveRead']
type AdminScheduleSolveListResponse =
  components['schemas']['AdminScheduleSolveListResponse']

/** A single physical table, `T1` on court 1. */
export function buildTournamentTable(
  overrides: Partial<TournamentTable> = {},
): TournamentTable {
  return { id: 't1', label: 'T1', court: '1', ...overrides }
}

/** One active entrant, **rated** (1450 on the tournament's ladder). `id` is the
 * ENTRY's id — the address a withdrawal is sent to (`DELETE …/entries/{entry_id}`)
 * — not the player's.
 *
 * `rating: null` is the *unrated* entrant (ADR-0783 §3): the server resolved that
 * this player holds no rating on the tournament's league, so they pass every rating
 * rule and the roster marks them. It is a state a fixture asks for explicitly —
 * rated is the ordinary case. */
export function buildTournamentEntrantRead(
  overrides: Partial<TournamentEntrantRead> = {},
): TournamentEntrantRead {
  return {
    id: 'entry-1',
    user_id: 'u-rita',
    username: 'rita.kovac',
    seed: null,
    rating: 1450,
    ...overrides,
  }
}

/** `count` distinct entrants (`entry-1`/`player.1`, `entry-2`/`player.2`, …) —
 * for the cases that care about how MANY entrants an event has, not who.
 * `overrides` apply to every one of them (e.g. `{ rating: null }` for a roster of
 * uniformly unrated entrants). */
export function buildTournamentEntrantReads(
  count: number,
  overrides: Partial<TournamentEntrantRead> = {},
): TournamentEntrantRead[] {
  return Array.from({ length: count }, (_, i) =>
    buildTournamentEntrantRead({
      id: `entry-${i + 1}`,
      user_id: `u-${i + 1}`,
      username: `player.${i + 1}`,
      ...overrides,
    }),
  )
}

/** One fixture of a cut draw (ADR-0786) — round 1, position 1 of an un-pooled draw,
 * both sides known, undecided and not yet materialized.
 *
 * Every `null` here is a **fact**, and a fixture asks for each one explicitly: a null
 * side is **TBD** (never a bye — a bye is the absence of a fixture row), a null
 * `winner_entry_id` is undecided, a null `match_id` is un-materialized, and a null
 * `pool_id` is an un-pooled draw. The defaults are the ordinary case a director sees
 * the morning of: a planned pairing, both players known, nothing played — so
 * `match_status` is `null` too, moving in lockstep with `match_id`. Its **placement**
 * (ADR-0790) starts empty: `table_id` null is unassigned, `scheduled_start` null is
 * unscheduled — and **uncalled**: `pinned_at` null means the placement is still an
 * estimate the solver may move, and `call_notified_count` 0 means nobody has been
 * told anything (ADR "the schedule is solved, the call is pinned"). `completed_at`
 * null means the match has not actually finished yet, distinct from the placement's
 * merely *predicted* `scheduled_start`. */
export function buildTournamentFixtureRead(
  overrides: Partial<TournamentFixtureRead> = {},
): TournamentFixtureRead {
  return {
    id: 'fx-1',
    pool_id: null,
    round: 1,
    position: 1,
    entry_a_id: 'entry-1',
    entry_b_id: 'entry-2',
    winner_entry_id: null,
    match_id: null,
    match_status: null,
    table_id: null,
    scheduled_start: null,
    pinned_at: null,
    call_notified_count: 0,
    completed_at: null,
    ...overrides,
  }
}

/** One row of the tournament's **solve ledger** (`ScheduleSolveRead`, ADR "the
 * schedule is solved, the call is pinned") — by default a *finished, successful*
 * manual run: the owner pressed Run scheduler, the solver proved the plan optimal
 * in under a second, and every one of nine fixtures got a placement.
 *
 * The defaults are internally consistent for the `succeeded` status — every stage
 * reached, so every stage-marking field is set. A fixture that wants an earlier
 * stage overrides the status *and* nulls the fields that stage has not reached
 * (`queued`: everything after `requested_at` null; `failed`: `verdict` and the
 * apply counts null, `error` set) — each `null` is a fact about how far the run
 * got, not a missing field. */
export function buildScheduleSolveRead(
  overrides: Partial<ScheduleSolveRead> = {},
): ScheduleSolveRead {
  return {
    id: 'solve-1',
    trigger: 'manual',
    status: 'succeeded',
    verdict: 'optimal',
    requested_at: '2026-06-13T09:00:00Z',
    started_at: '2026-06-13T09:00:01Z',
    finished_at: '2026-06-13T09:00:02Z',
    wall_time_ms: 850,
    fixtures_placed: 9,
    fixtures_pinned: 0,
    error: null,
    // A succeeded run has no infeasibility reasons; the field is always a list
    // (`[]` off the infeasible path). Infeasible fixtures override this.
    infeasibility_reasons: [],
    ...overrides,
  }
}

/** One row of the **admin** solve ledger (`AdminScheduleSolveRead`, the
 * cross-tournament read backing `/admin/schedule-solves`): every field of
 * `buildScheduleSolveRead`, plus the operator-only facts the tournament-facing
 * read omits — the drift guard's `input_fingerprint` (`null` = the run never
 * snapshotted), the coalescer's `rerun_requested` (a trigger landed while this
 * run was `running`; always `false` on terminal rows), and the owning
 * tournament's id + live name. */
export function buildAdminScheduleSolveRead(
  overrides: Partial<AdminScheduleSolveRead> = {},
): AdminScheduleSolveRead {
  return {
    ...buildScheduleSolveRead(),
    input_fingerprint:
      'a3f1c2e94b7d80561e2f9c4a7d3b8e05a3f1c2e94b7d80561e2f9c4a7d3b8e05',
    rerun_requested: false,
    tournament_id: 'bay-area-open-2026',
    tournament_name: 'Bay Area Open 2026',
    ...overrides,
  }
}

/**
 * Page a full admin solve ledger the way `/v1/admin/schedule-solves` does:
 * `tournament_id` narrows, `total` counts the rows matching that same filter,
 * and the slice is `page`/`page_size`. It does **not** re-sort — the API's
 * newest-first ordering is the seed's job, exactly as it is the database's.
 *
 * Shared by the dev-world MSW handler, the vitest page object and the e2e
 * `page.route` stub, so all three worlds answer the page's query params with
 * one implementation instead of three drifting ones.
 */
export function pageAdminScheduleSolves(
  rows: AdminScheduleSolveRead[],
  params: { tournament_id?: string | null; page?: number; page_size?: number },
): AdminScheduleSolveListResponse {
  const page = params.page ?? 1
  const pageSize = params.page_size ?? 25
  const filtered = params.tournament_id
    ? rows.filter((r) => r.tournament_id === params.tournament_id)
    : rows
  return {
    items: filtered.slice((page - 1) * pageSize, page * pageSize),
    page,
    page_size: pageSize,
    total: filtered.length,
  }
}

/**
 * The dev world's solve ledger — enough rows (34) that page 1 truncates at 25
 * (small fixtures hide acceptance bugs), spread over the seeded tournaments so
 * the Tournament links land on detail pages that exist under `npm run dev`,
 * with every terminal shape visible on page 1: succeeded (optimal *and*
 * feasible), infeasible, failed (with the server's error sentence), a run
 * still `running` with a re-run already coalesced onto it, and one `queued`.
 * Newest request first, exactly as the API orders it.
 */
export function buildAdminSolveLedgerSeed(): AdminScheduleSolveRead[] {
  const tournaments = [
    { id: 'bay-area-open-2026', name: 'Bay Area Open 2026' },
    { id: 'summer-slam-2026', name: 'Summer Slam 2026' },
  ] as const
  // Newest first: minute 59 down to 26.
  const runs = Array.from({ length: 34 }, (_, i) => {
    const t = tournaments[i % tournaments.length]
    const minute = String(59 - i).padStart(2, '0')
    return buildAdminScheduleSolveRead({
      id: `admin-solve-${i + 1}`,
      trigger: (['match_completed', 'manual', 'settings_changed', 'pin_tick'] as const)[
        i % 4
      ],
      requested_at: `2026-07-15T10:${minute}:00Z`,
      started_at: `2026-07-15T10:${minute}:01Z`,
      finished_at: `2026-07-15T10:${minute}:03Z`,
      tournament_id: t.id,
      tournament_name: t.name,
    })
  })
  // Carve the interesting shapes into the newest rows so they sit on page 1.
  runs[0] = {
    ...runs[0],
    status: 'queued',
    verdict: null,
    started_at: null,
    finished_at: null,
    wall_time_ms: null,
    fixtures_placed: null,
    fixtures_pinned: null,
  }
  runs[1] = {
    ...runs[1],
    status: 'running',
    verdict: null,
    finished_at: null,
    wall_time_ms: null,
    fixtures_placed: null,
    fixtures_pinned: null,
    rerun_requested: true,
  }
  runs[2] = {
    ...runs[2],
    status: 'failed',
    verdict: null,
    wall_time_ms: null,
    fixtures_placed: null,
    fixtures_pinned: null,
    error: 'worker crashed: out of memory in CP-SAT presolve',
  }
  runs[3] = {
    ...runs[3],
    status: 'infeasible',
    verdict: 'infeasible',
    fixtures_placed: null,
    fixtures_pinned: null,
  }
  runs[4] = { ...runs[4], verdict: 'feasible', wall_time_ms: 2400 }
  return runs
}

/**
 * Plan a **round-robin** draw the way the API plans one (`api/app/draws.py`): snake the
 * ordered entrants across the pools, then pair each pool by the circle method — every
 * pair meets once, nobody plays twice in a round.
 *
 * The mock's planner is faithful rather than convenient on purpose. A stub that dealt
 * the field into pools any old way would still *look* like a draw on screen, and the
 * page built against it would be a page built against a shape the server never sends —
 * the fixture count, the rounds, and which two names share a row would all be fiction.
 * The rules it mirrors, each of which is visible on the card:
 *
 * - **Snake, not blocks** — pool A takes seeds 1, 2P, 2P+1, …; pool B takes 2, 2P−1, …
 *   — so the top seeds land one per pool and pool sizes differ by at most one.
 * - **A bye is the ABSENCE of a fixture.** An odd pool gets a phantom seat; whoever
 *   draws it that round simply has no fixture. There is no `is_bye`, and no null side.
 * - **`position` is contiguous within a (pool, round)** — 1..k — because the phantom's
 *   pairing is never emitted.
 *
 * Returns fixtures in pool → round → position order, as the wire does.
 *
 * ⚠️ It does **not** enforce the API's refusals (no pools, a pool of fewer than two).
 * Those are the *store's* to refuse (`cutDraw`, `tournaments-store.ts`), because they
 * are answers to a request, not shapes of a payload. Handed a degenerate field this
 * plans what it is asked for — which is why nothing but the store should call it.
 */
export function planRoundRobinFixtures(
  entryIds: readonly string[],
  poolIds: readonly string[],
): TournamentFixtureRead[] {
  const fixtures: TournamentFixtureRead[] = []
  let counter = 0

  for (const [poolIndex, poolId] of poolIds.entries()) {
    // The snake: row-by-row across the pools, reversing every other row.
    const members = entryIds.filter((_, index) => {
      const row = Math.floor(index / poolIds.length)
      const offset = index % poolIds.length
      const column = row % 2 === 0 ? offset : poolIds.length - 1 - offset
      return column === poolIndex
    })

    // The circle method: pin the first seat, rotate the rest one step per round, and
    // pair across the circle. An odd pool gets a phantom (`null`) seat — the entrant
    // drawn against it sits that round out, and no fixture is emitted for them.
    const circle: (string | null)[] = [...members]
    if (circle.length % 2 === 1) circle.push(null)
    const seats = circle.length

    for (let round = 1; round < seats; round += 1) {
      let position = 0
      for (let seat = 0; seat < seats / 2; seat += 1) {
        const home = circle[seat]
        const away = circle[seats - 1 - seat]
        if (home === null || away === null) continue
        position += 1
        counter += 1
        fixtures.push(
          buildTournamentFixtureRead({
            id: `fx-${poolId}-${counter}`,
            pool_id: poolId,
            round,
            position,
            entry_a_id: home,
            entry_b_id: away,
          }),
        )
      }
      circle.splice(1, 0, circle.pop() as string | null)
    }
  }

  return fixtures
}

/** One wire standings row (`StandingRowRead`, ADR-0788): entry `entry-1`, 1st, a clean
 * 2–0 with a +3 game difference. `game_difference` is the server's own figure
 * (`games_won - games_lost`), carried as-is; the factory keeps it consistent by default. */
export function buildStandingRowRead(
  overrides: Partial<StandingRowRead> = {},
): StandingRowRead {
  return {
    entry_id: 'entry-1',
    rank: 1,
    played: 2,
    wins: 2,
    losses: 0,
    games_won: 4,
    games_lost: 1,
    game_difference: 3,
    ...overrides,
  }
}

/** One wire pool's standings (`PoolStandingsRead`): a complete three-player pool in the
 * server's finishing order — `entry-1` (2–0) over `entry-4` (1–1) over `entry-5` (0–2). In
 * order, which the client renders untouched (ADR-0788). */
export function buildPoolStandingsRead(
  overrides: Partial<PoolStandingsRead> = {},
): PoolStandingsRead {
  return {
    pool_id: 'p-a',
    complete: true,
    rows: [
      buildStandingRowRead({
        entry_id: 'entry-1',
        rank: 1,
        wins: 2,
        losses: 0,
        games_won: 4,
        games_lost: 1,
        game_difference: 3,
      }),
      buildStandingRowRead({
        entry_id: 'entry-4',
        rank: 2,
        wins: 1,
        losses: 1,
        games_won: 3,
        games_lost: 3,
        game_difference: 0,
      }),
      buildStandingRowRead({
        entry_id: 'entry-5',
        rank: 3,
        wins: 0,
        losses: 2,
        games_won: 1,
        games_lost: 4,
        game_difference: -3,
      }),
    ],
    ...overrides,
  }
}

/** A wire event's results (`EventResultsRead`, ADR-0788): one complete single pool with a
 * champion (`entry-1`, who won it). Single-pool so `champion` is meaningful — a multi-pool
 * event has no single champion without a knockout stage yet (pass extra `pools` +
 * `champion: null` for that). */
export function buildEventResultsRead(
  overrides: Partial<EventResultsRead> = {},
): EventResultsRead {
  return {
    pools: [buildPoolStandingsRead()],
    complete: true,
    champion: 'entry-1',
    ...overrides,
  }
}

/**
 * What the event says about the CALLER entering it (ADR-0783), derived the way the
 * server derives the half of it that is derivable: an event holding `max_players`
 * active entrants is `event_full`, and anything else is `open`.
 *
 * ⚠️ **An UNCAPPED event (`max_players: null`, ADR-0935) is never full** — the API
 * guarantees it, and so does the mock, because a mock that disagrees with the server
 * about a designed state is a mock that will green-light the bug. Written as an
 * explicit null check rather than left to the comparison: `entrants.length >= null`
 * coerces the cap to `0`, so an uncapped event would come back `event_full` the
 * moment anyone entered it — and the card under test would be reading a payload the
 * real API cannot send.
 *
 * `rating_ineligible` is NOT derivable from an event alone — it is a judgement
 * about a player's rating on the tournament's ladder, which no mock payload
 * carries — so a fixture that wants it passes it explicitly. What this function
 * buys is that the *capacity* arm cannot lie: a 64-of-64 event minted by these
 * factories says `event_full`, whatever the caller forgot to pass.
 */
export function entryStateFor(
  event: Pick<TournamentEventRead, 'entrants' | 'max_players'>,
): TournamentEventRead['entry_state'] {
  if (event.max_players === null) return { state: 'open' }
  return event.entrants.length >= event.max_players
    ? { state: 'event_full' }
    : { state: 'open' }
}

/**
 * A rated Bo5 "Open Singles" event with one morning pool, as returned by the
 * tournament detail/list endpoints. Defaults are internally consistent so a
 * bare call is a meaningful row.
 *
 * `entered` is NOT an override: like the server (ADR-0016) it is derived from
 * `entrants`, so this factory cannot mint an event whose count disagrees with
 * its list. Want an event with 22 entries? Give it 22 `entrants`.
 *
 * `entry_state` IS an override — the server computes it per caller (ADR-0783), and
 * `rating_ineligible` cannot be derived from an event's own fields — but it
 * **defaults to `entryStateFor`**, so an event filled to `max_players` reports
 * itself full without anybody remembering to say so.
 *
 * `fixtures` defaults to **`[]` — an event with NO DRAW CUT** (ADR-0786), which is the
 * state every event is born in and stays in until a director cuts one. It is an
 * override, not a derivation: a draw is an explicit act against a field, not a function
 * of the entrants (the same 9 players make a different draw across 2 pools than across
 * 3), so a factory that quietly cut one would be inventing a decision nobody made.
 * `planRoundRobinFixtures` above builds a real one for the fixtures that want a *drawn*
 * event.
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
    entry_state: { state: 'open' },
    fixtures: [],
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
    // NO RESULTS (ADR-0788) — `null` is the designed state of an event with no draw (and of
    // any non-round-robin event); standings only appear once a draw is cut and matches
    // land. A fixture that wants a table passes a `buildEventResultsRead()` override.
    results: null,
    created_at: '2026-06-01T09:05:00Z',
    updated_at: '2026-06-09T12:00:00Z',
    ...overrides,
  } satisfies Omit<TournamentEventRead, 'entered'>
  return {
    ...event,
    entry_state: overrides.entry_state ?? entryStateFor(event),
    entered: event.entrants.length,
  }
}

/**
 * The published "Bay Area Open 2026" with a four-table catalogue and a single
 * Open Singles event, owned (editable) by the current user. The list and detail
 * endpoints both return this `TournamentDetailRead` shape.
 *
 * `league_id` is the ladder its eligibility rules are judged against (ADR-0783)
 * — the **default** league here, as an omitted one resolves to on the server.
 * Nothing renders it yet; it is carried so the fixture is the shape the wire
 * actually sends.
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
    league_id: FORTYMM_LEAGUE_ID,
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
    // NO SOLVE YET — `null` is the state every tournament is born in, and the state
    // it stays in until something (go-live, the Run-scheduler button, a completed
    // match) puts a run on the queue. A fixture that wants a solve on the strip
    // passes a `buildScheduleSolveRead()` override.
    latest_schedule_solve: null,
    ...overrides,
  }
}
