import type { components } from '@/api/schema'

type MatchStatus = components['schemas']['MatchStatus']
type MatchDetails = components['schemas']['MatchDetails']
type MatchDetailsSide = components['schemas']['MatchDetailsSide']
type MatchDetailsGame = components['schemas']['MatchDetailsGame']
type MatchListRow = components['schemas']['MatchListRow']
type MatchLeague = components['schemas']['MatchLeague']
type DashboardScoreBanner = components['schemas']['DashboardScoreBanner']
type DashboardNextMatch = components['schemas']['DashboardNextMatch']
type DashboardRecentResult = components['schemas']['DashboardRecentResult']

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
  const anyScored = side1 > 0 || side2 > 0

  if (decided) {
    seed.status = 'completed'
    // Runtime-completed matches need a fresh timestamp so dashboard's
    // recent-results sort puts them ahead of pre-seeded older matches.
    if (seed.completed_at === null) seed.completed_at = new Date().toISOString()
    seed.games = seed.games.filter((g) => g.score !== null)
  } else {
    seed.status = anyScored ? 'in_progress' : 'pending'
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
    won: decided ? side1 > side2 : null,
    is_current_user_side: true,
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
        won: decided ? side2 > side1 : null,
        is_current_user_side: false,
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
            my_points: g.score.side_1_points,
            opponent_points: g.score.side_2_points,
            is_my_win: g.score.side_1_points > g.score.side_2_points,
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
    my_side: mySide,
    opponent_side: opponentSide,
    games,
    current_game: current
      ? { id: current.id, game_number: current.game_number }
      : null,
    can_score: current !== null && opponentSide !== null,
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
  return {
    match_id: seed.id,
    opponent_username: seed.opponent.username,
    is_win: side1 > side2,
    my_games_won: side1,
    opponent_games_won: side2,
    completed_at: seed.completed_at ?? seed.created_at,
  }
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
    status: 'pending',
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
