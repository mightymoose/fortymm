import type { components } from '@/api/schema'

type MatchStatus = components['schemas']['MatchStatus']
type MatchDetails = components['schemas']['MatchDetails']
type MatchDetailsSide = components['schemas']['MatchDetailsSide']
type MatchDetailsGame = components['schemas']['MatchDetailsGame']
type MatchDetailsPlayerForm = components['schemas']['MatchDetailsPlayerForm']
type MatchDetailsFormResult = components['schemas']['MatchDetailsFormResult']
type MatchDetailsH2H = components['schemas']['MatchDetailsH2H']
type MatchDetailsH2HMeeting = components['schemas']['MatchDetailsH2HMeeting']
type MatchListRow = components['schemas']['MatchListRow']
type MatchLeague = components['schemas']['MatchLeague']
type DashboardScoreBanner = components['schemas']['DashboardScoreBanner']
type DashboardNextMatch = components['schemas']['DashboardNextMatch']
type DashboardRecentResult = components['schemas']['DashboardRecentResult']
type DashboardRating = components['schemas']['DashboardRating']
type DashboardStreak = components['schemas']['DashboardStreak']
type RatingChange = components['schemas']['RatingChange']

const MOCK_BASE_RATING = 1500
const MOCK_RATING_DELTA = 8
const RECENT_FORM_LIMIT = 5
const H2H_LIMIT = 5

function ratingChangeFor(seedId: string, won: boolean): RatingChange {
  // Deterministic so re-renders are stable.
  let h = 0
  for (let i = 0; i < seedId.length; i += 1) h = (h * 31 + seedId.charCodeAt(i)) | 0
  const jitter = Math.abs(h) % 7
  const magnitude = MOCK_RATING_DELTA + jitter
  const signed = won ? magnitude : -magnitude
  return {
    before: MOCK_BASE_RATING,
    after: MOCK_BASE_RATING + signed,
    delta: signed,
  }
}

// The mock-session user — handlers project every seed match as if this user
// is on side 1, so `is_current_user_side` and `my_games_won` line up with
// what the dev session would actually see.
export const MOCK_CURRENT_USER = { id: 'u-me', username: 'rita.kovac' }

// The seeded default league every mock match belongs to. Mirrors the
// FortyMM row scripts/seed_leagues.py inserts on real boot.
export const MOCK_DEFAULT_LEAGUE: MatchLeague = {
  id: 'lg-fortymm',
  name: 'FortyMM',
}

const STATUS_LABELS: Record<MatchStatus, string> = {
  pending: 'Scheduled',
  in_progress: 'Live',
  completed: 'Final',
  disputed: 'Disputed',
  voided: 'Voided',
}

const ALL_STATUSES: MatchStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'disputed',
  'voided',
]

export type SeedGame = {
  id: string
  game_number: number
  score: { id: string; side_1_points: number; side_2_points: number } | null
}

export type SeedMatch = {
  id: string
  status: MatchStatus
  best_of: number
  affects_rating: boolean
  created_at: string
  completed_at: string | null
  opponent: { id: string; username: string } | null
  games: SeedGame[]
}

function gamesToWin(bestOf: number): number {
  return Math.ceil(bestOf / 2)
}

function sideWinCounts(seed: SeedMatch): { side1: number; side2: number } {
  let s1 = 0
  let s2 = 0
  for (const g of seed.games) {
    if (!g.score) continue
    if (g.score.side_1_points > g.score.side_2_points) s1 += 1
    else if (g.score.side_2_points > g.score.side_1_points) s2 += 1
  }
  return { side1: s1, side2: s2 }
}

function currentUnscored(seed: SeedMatch): SeedGame | null {
  return seed.games.find((g) => g.score === null) ?? null
}

/** Mirrors the API's `_recompute_match`: derive status / side `won`, drop any
 * trailing unscored game on completion, append one when still in progress. */
export function reconcile(seed: SeedMatch): void {
  const { side1, side2 } = sideWinCounts(seed)
  const target = gamesToWin(seed.best_of)
  const decided = side1 >= target || side2 >= target

  if (decided) {
    seed.status = 'completed'
    // Runtime-completed matches need a fresh timestamp so dashboard's
    // recent-results sort puts them ahead of pre-seeded older matches.
    if (seed.completed_at === null) seed.completed_at = new Date().toISOString()
    seed.games = seed.games.filter((g) => g.score !== null)
  } else {
    seed.status = 'in_progress'
    seed.completed_at = null
    if (currentUnscored(seed) === null && seed.opponent !== null) {
      const nextNumber =
        seed.games.reduce((max, g) => Math.max(max, g.game_number), 0) + 1
      seed.games.push({
        id: `g-${seed.id}-${nextNumber}`,
        game_number: nextNumber,
        score: null,
      })
    }
  }
}

function projectSides(seed: SeedMatch): {
  mySide: MatchDetailsSide
  opponentSide: MatchDetailsSide | null
} {
  const { side1, side2 } = sideWinCounts(seed)
  const decided = seed.status === 'completed'

  const showRatingChange = decided && seed.affects_rating && seed.opponent !== null
  const myWon = side1 > side2

  const mySide: MatchDetailsSide = {
    side_number: 1,
    players: [
      {
        user_id: MOCK_CURRENT_USER.id,
        username: MOCK_CURRENT_USER.username,
        is_current_user: true,
      },
    ],
    games_won: side1,
    won: decided ? myWon : null,
    is_current_user_side: true,
    rating_change: showRatingChange ? ratingChangeFor(seed.id, myWon) : null,
  }
  const opponentSide: MatchDetailsSide | null = seed.opponent
    ? {
        side_number: 2,
        players: [
          {
            user_id: seed.opponent.id,
            username: seed.opponent.username,
            is_current_user: false,
          },
        ],
        games_won: side2,
        won: decided ? !myWon : null,
        is_current_user_side: false,
        rating_change: showRatingChange ? ratingChangeFor(seed.id, !myWon) : null,
      }
    : null
  return { mySide, opponentSide }
}

export function projectMatchDetails(seed: SeedMatch): MatchDetails {
  const { mySide, opponentSide } = projectSides(seed)

  const games: MatchDetailsGame[] = seed.games
    .slice()
    .sort((a, b) => a.game_number - b.game_number)
    .map((g) => ({
      id: g.id,
      game_number: g.game_number,
      score: g.score
        ? {
            id: g.score.id,
            side_1_points: g.score.side_1_points,
            side_2_points: g.score.side_2_points,
            winner_side_number:
              g.score.side_1_points > g.score.side_2_points ? 1 : 2,
          }
        : null,
    }))

  const current = currentUnscored(seed)
  return {
    id: seed.id,
    status: seed.status,
    status_label: STATUS_LABELS[seed.status],
    league: MOCK_DEFAULT_LEAGUE,
    best_of: seed.best_of,
    games_to_win: gamesToWin(seed.best_of),
    team_size: 1,
    affects_rating: seed.affects_rating,
    created_at: seed.created_at,
    sides: opponentSide ? [mySide, opponentSide] : [mySide],
    games,
    current_game: current
      ? { id: current.id, game_number: current.game_number }
      : null,
    can_score: current !== null && opponentSide !== null,
    recent_form: projectRecentForm(seed),
    head_to_head: projectHeadToHead(seed),
  }
}

function priorCompleted(seed: SeedMatch): SeedMatch[] {
  return mockMatches
    .filter(
      (m): m is SeedMatch & { completed_at: string } =>
        m.status === 'completed' &&
        m.completed_at !== null &&
        m.id !== seed.id,
    )
    .sort((a, b) => b.completed_at.localeCompare(a.completed_at))
}

function recentResultsFor(
  userId: string,
  seeds: SeedMatch[],
): MatchDetailsFormResult[] {
  const results: MatchDetailsFormResult[] = []
  for (const m of seeds) {
    // The mock current-user always sits on side 1; everyone else's matches
    // are inferred from `m.opponent.id`.
    const onSide1 = userId === MOCK_CURRENT_USER.id
    const onSide2 = m.opponent !== null && m.opponent.id === userId
    if (!onSide1 && !onSide2) continue
    const { side1, side2 } = sideWinCounts(m)
    const won = onSide1 ? side1 > side2 : side2 > side1
    const playerGames = onSide1 ? side1 : side2
    const opponentGames = onSide1 ? side2 : side1
    const opponentUsername = onSide1
      ? (m.opponent?.username ?? null)
      : MOCK_CURRENT_USER.username
    results.push({
      match_id: m.id,
      is_win: won,
      player_games_won: playerGames,
      opponent_games_won: opponentGames,
      opponent_username: opponentUsername,
      completed_at: m.completed_at ?? m.created_at,
    })
    if (results.length === RECENT_FORM_LIMIT) break
  }
  return results
}

function projectRecentForm(seed: SeedMatch): MatchDetailsPlayerForm[] {
  const completed = priorCompleted(seed)
  const userIds = [
    MOCK_CURRENT_USER.id,
    ...(seed.opponent ? [seed.opponent.id] : []),
  ]
  return userIds.map((user_id) => ({
    user_id,
    recent_results: recentResultsFor(user_id, completed),
  }))
}

function projectHeadToHead(seed: SeedMatch): MatchDetailsH2H | null {
  if (seed.opponent === null) return null
  const completed = priorCompleted(seed).filter(
    (m) => m.opponent !== null && m.opponent.id === seed.opponent!.id,
  )
  const meetings: MatchDetailsH2HMeeting[] = []
  let side1Wins = 0
  let side2Wins = 0
  for (const m of completed) {
    const { side1, side2 } = sideWinCounts(m)
    // In the seed model the current user is always on side 1 of every past
    // match — same orientation as the current match — so per-row counts
    // line up directly with this match's side numbers.
    const winner: number | null =
      side1 > side2 ? 1 : side2 > side1 ? 2 : null
    if (winner === 1) side1Wins += 1
    if (winner === 2) side2Wins += 1
    meetings.push({
      match_id: m.id,
      completed_at: m.completed_at ?? m.created_at,
      side_1_games_won: side1,
      side_2_games_won: side2,
      winner_side_number: winner,
    })
  }
  return {
    total_meetings: meetings.length,
    side_1_wins: side1Wins,
    side_2_wins: side2Wins,
    recent_meetings: meetings.slice(0, H2H_LIMIT),
  }
}

export function projectListRow(seed: SeedMatch): MatchListRow {
  const { mySide, opponentSide } = projectSides(seed)
  const current = currentUnscored(seed)
  const scorable =
    (seed.status === 'pending' || seed.status === 'in_progress') &&
    opponentSide !== null &&
    current !== null
  return {
    id: seed.id,
    status: seed.status,
    status_label: STATUS_LABELS[seed.status],
    league: MOCK_DEFAULT_LEAGUE,
    sides: opponentSide ? [mySide, opponentSide] : [mySide],
    best_of: seed.best_of,
    created_at: seed.created_at,
    current_game_id: scorable ? current.id : null,
    can_score: scorable,
  }
}

export function projectScoreBanner(seed: SeedMatch): DashboardScoreBanner | null {
  const current = currentUnscored(seed)
  if (seed.status !== 'in_progress' || current === null) return null
  return {
    match_id: seed.id,
    opponent_username: seed.opponent?.username ?? null,
    current_game_id: current.id,
  }
}

export function projectNextMatch(seed: SeedMatch): DashboardNextMatch | null {
  if (seed.status !== 'pending') return null
  return {
    match_id: seed.id,
    opponent_username: seed.opponent?.username ?? null,
    best_of: seed.best_of,
    created_at: seed.created_at,
  }
}

export function projectRecentResult(seed: SeedMatch): DashboardRecentResult | null {
  if (seed.status !== 'completed' || seed.opponent === null) return null
  const { side1, side2 } = sideWinCounts(seed)
  const won = side1 > side2
  return {
    match_id: seed.id,
    opponent_username: seed.opponent.username,
    is_win: won,
    my_games_won: side1,
    opponent_games_won: side2,
    completed_at: seed.completed_at ?? seed.created_at,
    my_rating_change: seed.affects_rating ? ratingChangeFor(seed.id, won) : null,
  }
}

/** Synthesize the dashboard rating block by walking completed seeds in
 * chronological order, applying each seed's deterministic delta. The result
 * mirrors what the real BFF builds out of `rating_history` and
 * `user_league_ratings`, so the wired RatingCard renders against the same
 * shape MSW and prod return. */
export function projectRating(seeds: SeedMatch[]): DashboardRating {
  const completed = seeds
    .filter(
      (s): s is SeedMatch & { completed_at: string } =>
        s.status === 'completed' &&
        s.completed_at !== null &&
        s.opponent !== null &&
        s.affects_rating,
    )
    .sort((a, b) => a.completed_at.localeCompare(b.completed_at))

  let current = MOCK_BASE_RATING
  let peak = MOCK_BASE_RATING
  let lastDelta = 0
  const sparkData: number[] = []
  for (const seed of completed) {
    const { side1, side2 } = sideWinCounts(seed)
    const won = side1 > side2
    const change = ratingChangeFor(seed.id, won)
    current += change.delta
    lastDelta = change.delta
    peak = Math.max(peak, current)
    sparkData.push(current)
  }
  // Glicko-2-ish gloss: RD tightens with games played, volatility holds.
  const gamesPlayed = completed.length
  const rd = Math.max(80, 350 - gamesPlayed * 18)
  return {
    league_id: MOCK_DEFAULT_LEAGUE.id,
    league_name: MOCK_DEFAULT_LEAGUE.name,
    strategy_key: 'glicko2',
    current,
    delta: lastDelta,
    peak,
    percentile: gamesPlayed > 0 ? 72 : null,
    spark_data: sparkData,
    streak: projectStreak(seeds),
    stats: [
      { label: 'RD', value: String(rd) },
      { label: 'Volatility', value: '0.058' },
    ],
  }
}

export function projectStreak(seeds: SeedMatch[]): DashboardStreak | null {
  const completed = seeds
    .filter(
      (s): s is SeedMatch & { completed_at: string } =>
        s.status === 'completed' &&
        s.completed_at !== null &&
        s.opponent !== null,
    )
    .sort((a, b) => b.completed_at.localeCompare(a.completed_at))
  let kind: 'W' | 'L' | null = null
  let n = 0
  for (const seed of completed) {
    const { side1, side2 } = sideWinCounts(seed)
    const won = side1 > side2
    const thisKind: 'W' | 'L' = won ? 'W' : 'L'
    if (kind === null) {
      kind = thisKind
      n = 1
    } else if (thisKind === kind) {
      n += 1
    } else {
      break
    }
  }
  return kind === null ? null : { kind, n }
}

/** Single source of truth for the per-status histogram returned alongside
 * the paginated list — the FE renders pill counts from this. */
export function statusCountsOf(seeds: SeedMatch[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(
    ALL_STATUSES.map((s) => [s, 0]),
  )
  for (const s of seeds) counts[s.status] = (counts[s.status] ?? 0) + 1
  return counts
}

/** Seed snapshot used at module load. `m-2207` is the deterministic
 * in-progress match the score-entry e2e hard-codes into its URL. */
export function buildInitialSeeds(): SeedMatch[] {
  return [
    {
      id: 'm-pending-1',
      status: 'pending',
      best_of: 5,
      affects_rating: true,
      created_at: '2026-05-14T17:00:00Z',
      completed_at: null,
      opponent: { id: 'pl-okafor', username: 'okafor.d' },
      games: [
        { id: 'g-pending-1-1', game_number: 1, score: null },
      ],
    },
    {
      id: 'm-2207',
      status: 'in_progress',
      best_of: 5,
      affects_rating: true,
      created_at: '2026-05-12T19:00:00Z',
      completed_at: null,
      opponent: { id: 'pl-nguyen', username: 'nguyen.t' },
      games: [
        {
          id: 'g-2207-1',
          game_number: 1,
          score: { id: 's-2207-1', side_1_points: 11, side_2_points: 8 },
        },
        {
          id: 'g-2207-2',
          game_number: 2,
          score: { id: 's-2207-2', side_1_points: 9, side_2_points: 11 },
        },
        { id: 'g-2207-3', game_number: 3, score: null },
      ],
    },
    {
      id: 'm-completed-win-1',
      status: 'completed',
      best_of: 5,
      affects_rating: true,
      created_at: '2026-05-10T18:00:00Z',
      completed_at: '2026-05-10T18:42:00Z',
      opponent: { id: 'pl-silva', username: 'silva.r' },
      games: [
        {
          id: 'g-cw-1-1',
          game_number: 1,
          score: { id: 's-cw-1-1', side_1_points: 11, side_2_points: 7 },
        },
        {
          id: 'g-cw-1-2',
          game_number: 2,
          score: { id: 's-cw-1-2', side_1_points: 11, side_2_points: 9 },
        },
        {
          id: 'g-cw-1-3',
          game_number: 3,
          score: { id: 's-cw-1-3', side_1_points: 8, side_2_points: 11 },
        },
        {
          id: 'g-cw-1-4',
          game_number: 4,
          score: { id: 's-cw-1-4', side_1_points: 12, side_2_points: 10 },
        },
      ],
    },
    {
      id: 'm-completed-loss-1',
      status: 'completed',
      best_of: 3,
      affects_rating: true,
      created_at: '2026-05-08T20:00:00Z',
      completed_at: '2026-05-08T20:25:00Z',
      opponent: { id: 'pl-patel', username: 'patel.m' },
      games: [
        {
          id: 'g-cl-1-1',
          game_number: 1,
          score: { id: 's-cl-1-1', side_1_points: 6, side_2_points: 11 },
        },
        {
          id: 'g-cl-1-2',
          game_number: 2,
          score: { id: 's-cl-1-2', side_1_points: 9, side_2_points: 11 },
        },
      ],
    },
    {
      id: 'm-completed-win-2',
      status: 'completed',
      best_of: 3,
      affects_rating: true,
      created_at: '2026-05-06T19:00:00Z',
      completed_at: '2026-05-06T19:20:00Z',
      opponent: { id: 'pl-chen', username: 'chen.w' },
      games: [
        {
          id: 'g-cw-2-1',
          game_number: 1,
          score: { id: 's-cw-2-1', side_1_points: 11, side_2_points: 4 },
        },
        {
          id: 'g-cw-2-2',
          game_number: 2,
          score: { id: 's-cw-2-2', side_1_points: 11, side_2_points: 6 },
        },
      ],
    },
  ]
}

/** Module-level store: a fresh snapshot is built on module load. Re-seeding
 * across HMR isn't a goal — Vite will simply rebuild the array. */
export const mockMatches: SeedMatch[] = buildInitialSeeds()

/** Restore the seed snapshot. Tests call this in `afterEach` so a test that
 * mutates the store (via `POST /v1/matches` or a score write through the
 * global handler) can't pollute the next test. */
export function resetMockMatches(): void {
  mockMatches.length = 0
  mockMatches.push(...buildInitialSeeds())
}

export function findMatch(matchId: string): SeedMatch | undefined {
  return mockMatches.find((m) => m.id === matchId)
}

/** Mirrors `MatchGameScoreWrite` model validation on the API. Returns the
 * same human-readable message the FE shows so error-display tests can rely
 * on it. */
export function validateScore(side1: number, side2: number): string | null {
  if (!Number.isInteger(side1) || side1 < 0 || side1 > 99) {
    return 'Each side must score between 0 and 99 points.'
  }
  if (!Number.isInteger(side2) || side2 < 0 || side2 > 99) {
    return 'Each side must score between 0 and 99 points.'
  }
  if (side1 === side2) return 'A game cannot end in a tie.'
  const winner = Math.max(side1, side2)
  const loser = Math.min(side1, side2)
  if (winner < 11) return 'The winning side must reach at least 11 points.'
  if (winner === 11 && loser > 9) {
    return `At 10–10 the game enters deuce; the winner must lead by 2. ${winner}–${loser} is not a legal final score.`
  }
  if (winner > 11) {
    if (loser < 10) {
      return `A game can only go past 11 points after both sides reach 10. ${winner}–${loser} is not a legal final score.`
    }
    if (winner - loser !== 2) {
      return `In a deuce game the winner leads by exactly 2 points. ${winner}–${loser} is not a legal final score.`
    }
  }
  return null
}

/** Hardcoded current-user id used by `POST /v1/matches` to populate side 1. */
export function newMatchSeed(input: {
  bestOf: number
  rated: boolean
  opponent: { id: string; username: string } | null
}): SeedMatch {
  const id = `m-${Date.now().toString(36)}`
  const seed: SeedMatch = {
    id,
    status: 'in_progress',
    best_of: input.bestOf,
    // A solo match (no opponent) can never affect ratings, mirroring the API.
    affects_rating: input.rated && input.opponent !== null,
    created_at: new Date().toISOString(),
    completed_at: null,
    opponent: input.opponent,
    games: [{ id: `g-${id}-1`, game_number: 1, score: null }],
  }
  return seed
}
