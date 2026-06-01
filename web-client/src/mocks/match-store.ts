import type { components } from '@/api/schema'

type MatchStatus = components['schemas']['MatchStatus']
type MatchDetails = components['schemas']['app__schemas__match__MatchDetails']
type MatchDetailsSide = components['schemas']['MatchDetailsSide']
type MatchDetailsGame = components['schemas']['MatchDetailsGame']
type MatchDetailsPlayerForm = components['schemas']['MatchDetailsPlayerForm']
type MatchDetailsFormResult = components['schemas']['MatchDetailsFormResult']
type MatchDetailsH2H = components['schemas']['MatchDetailsH2H']
type MatchDetailsH2HMeeting = components['schemas']['MatchDetailsH2HMeeting']
type MatchListRow = components['schemas']['MatchListRow']
type MatchLeague = components['schemas']['MatchLeague']
type MatchSignatureView = components['schemas']['MatchSignatureView']
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

export type SeedSignature = {
  user_id: string
  signed_at: string
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
  // Sign-offs on the posted canonical result. Empty until ``POST /results``
  // lands the first signature; cleared by ``POST /dispute``; "full" (one row
  // per side with players) once the match has been confirmed.
  signatures: SeedSignature[]
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

/** Lowest 1..best_of game number with no saved score, or null when every
 * game in [1, best_of] is scored / the match isn't in progress. Mirrors the
 * server's ``current_game_number`` derivation in api/app/matches.py. */
function currentGameNumber(seed: SeedMatch): number | null {
  if (seed.status !== 'in_progress') return null
  // A posted-but-unconfirmed result locks the scratchpad — no game is
  // "current" in a writable sense until the result is disputed.
  if (seed.signatures.length > 0) return null
  const scored = new Set(
    seed.games.filter((g) => g.score !== null).map((g) => g.game_number),
  )
  for (let n = 1; n <= seed.best_of; n += 1) {
    if (!scored.has(n)) return n
  }
  return null
}

/** Whether the currently-saved scores form a complete, validly-ordered,
 * decided match — i.e. POST /results would succeed against the current
 * scratchpad state. Mirrors the server's ``_can_finalize`` predicate. */
function canFinalizeSeed(seed: SeedMatch): boolean {
  if (seed.status !== 'in_progress') return false
  // Once a result is posted, /confirmation or /dispute is the next action,
  // not another /results.
  if (seed.signatures.length > 0) return false
  const scored = seed.games
    .filter((g) => g.score !== null)
    .map((g) => ({
      game_number: g.game_number,
      side_1_points: g.score!.side_1_points,
      side_2_points: g.score!.side_2_points,
    }))
  if (scored.length === 0) return false
  const numbers = scored.map((g) => g.game_number).sort((a, b) => a - b)
  if (numbers[numbers.length - 1] > seed.best_of) return false
  for (let i = 0; i < numbers.length; i += 1) {
    if (numbers[i] !== i + 1) return false
  }
  const target = gamesToWin(seed.best_of)
  const ordered = scored
    .slice()
    .sort((a, b) => a.game_number - b.game_number)
  let wins1 = 0
  let wins2 = 0
  let decidedAt: number | null = null
  for (const g of ordered) {
    if (g.side_1_points > g.side_2_points) wins1 += 1
    else if (g.side_2_points > g.side_1_points) wins2 += 1
    if (decidedAt === null && (wins1 >= target || wins2 >= target)) {
      decidedAt = g.game_number
    }
  }
  if (decidedAt === null) return false
  return decidedAt === ordered[ordered.length - 1].game_number
}

function projectSides(seed: SeedMatch): {
  mySide: MatchDetailsSide
  // Always present: a real opponent, or the player-less sentinel side that
  // makes an opponent-less match scorable (mirrors the API).
  opponentSide: MatchDetailsSide
} {
  const { side1, side2 } = sideWinCounts(seed)
  // After ``POST /results`` (non-solo) the canonical games have decided the
  // match even though status remains ``in_progress`` until the opponent
  // confirms; mirror the API so the hero scoreboard renders the winner
  // immediately rather than waiting on the confirmation round-trip.
  const decided = seed.status === 'completed' || seed.signatures.length > 0

  const showRatingChange =
    seed.status === 'completed' && seed.affects_rating && seed.opponent !== null
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
  const opponentSide: MatchDetailsSide = {
    side_number: 2,
    // No opponent → an empty (player-less) sentinel side.
    players: seed.opponent
      ? [
          {
            user_id: seed.opponent.id,
            username: seed.opponent.username,
            is_current_user: false,
          },
        ]
      : [],
    games_won: side2,
    won: decided ? !myWon : null,
    is_current_user_side: false,
    rating_change: showRatingChange ? ratingChangeFor(seed.id, !myWon) : null,
  }
  return { mySide, opponentSide }
}

function seedStatusLabel(seed: SeedMatch): string {
  if (seed.status === 'in_progress' && seed.signatures.length > 0) {
    return 'Awaiting confirmation'
  }
  return STATUS_LABELS[seed.status]
}

// Mirrors the backend scoreboard-status mapping (app/mappers/match_details_mapper.py):
// disputed and voided collapse to `final`, not `live`.
function seedScoreboardStatus(
  status: MatchStatus,
): components['schemas']['Status'] {
  switch (status) {
    case 'pending':
      return 'scheduled'
    case 'in_progress':
      return 'live'
    default:
      return 'final'
  }
}

function seedSignatureViews(seed: SeedMatch): MatchSignatureView[] {
  return seed.signatures
    .slice()
    .sort((a, b) => a.signed_at.localeCompare(b.signed_at))
    .map((sig) => ({ user_id: sig.user_id, signed_at: sig.signed_at }))
}

/** Mirrors the API's ``_can_confirm`` predicate from the mock current
 * user's perspective: they're a participant on an awaiting-confirmation
 * match (signatures non-empty, status in_progress, both sides have players)
 * and they themselves haven't signed yet. */
function canConfirmSeed(seed: SeedMatch): boolean {
  if (seed.status !== 'in_progress') return false
  if (seed.signatures.length === 0) return false
  if (seed.opponent === null) return false
  return !seed.signatures.some((sig) => sig.user_id === MOCK_CURRENT_USER.id)
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

  const nextNumber = currentGameNumber(seed)
  const priors = priorCompleted(seed)
  return {
    id: seed.id,
    status: seed.status,
    status_label: seedStatusLabel(seed),
    league: MOCK_DEFAULT_LEAGUE,
    best_of: seed.best_of,
    games_to_win: gamesToWin(seed.best_of),
    team_size: 1,
    affects_rating: seed.affects_rating,
    created_at: seed.created_at,
    sides: [mySide, opponentSide],
    games,
    current_game: nextNumber !== null ? { game_number: nextNumber } : null,
    can_score: nextNumber !== null,
    can_finalize: canFinalizeSeed(seed),
    can_confirm: canConfirmSeed(seed),
    signatures: seedSignatureViews(seed),
    recent_form: projectRecentForm(seed, priors),
    head_to_head: projectHeadToHead(seed, priors),
    data: { scoreboard: { status: seedScoreboardStatus(seed.status) } },
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

function winnerOf(seed: SeedMatch): 1 | 2 | null {
  const { side1, side2 } = sideWinCounts(seed)
  if (side1 > side2) return 1
  if (side2 > side1) return 2
  return null
}

function seedResultForUser(
  userId: string,
  m: SeedMatch,
): MatchDetailsFormResult | null {
  // The mock current-user always sits on side 1; everyone else's matches
  // are inferred from `m.opponent.id`.
  const onSide1 = userId === MOCK_CURRENT_USER.id
  const onSide2 = m.opponent !== null && m.opponent.id === userId
  if (!onSide1 && !onSide2) return null
  const { side1, side2 } = sideWinCounts(m)
  return {
    match_id: m.id,
    is_win: onSide1 ? side1 > side2 : side2 > side1,
    player_games_won: onSide1 ? side1 : side2,
    opponent_games_won: onSide1 ? side2 : side1,
    opponent_username: onSide1
      ? (m.opponent?.username ?? null)
      : MOCK_CURRENT_USER.username,
    completed_at: m.completed_at ?? m.created_at,
  }
}

function projectRecentForm(
  seed: SeedMatch,
  priors: SeedMatch[],
): MatchDetailsPlayerForm[] {
  const userIds = [
    MOCK_CURRENT_USER.id,
    ...(seed.opponent ? [seed.opponent.id] : []),
  ]
  return userIds.map((user_id) => {
    const recent_results: MatchDetailsFormResult[] = []
    for (const m of priors) {
      const row = seedResultForUser(user_id, m)
      if (row) recent_results.push(row)
      if (recent_results.length === RECENT_FORM_LIMIT) break
    }
    const wins = recent_results.filter((r) => r.is_win).length
    // The mock store doesn't track real rating moves, so synthesize a
    // deterministic-ish curve from the W/L pattern so the dev sparkline
    // looks alive. The real BFF returns RatingHistory rows here.
    const history = synthesizeRatingHistory(recent_results)
    return {
      user_id,
      recent_results,
      rating_before: history.length ? history[history.length - 1] : null,
      rating_history: history,
      career_matches_before: recent_results.length,
      career_wins_before: wins,
    }
  })
}

function synthesizeRatingHistory(
  recent: MatchDetailsFormResult[],
): number[] {
  if (recent.length === 0) return []
  // Walk newest → oldest results in reverse so the sparkline reads
  // chronologically; +12 per W, -10 per L is just enough to make the line
  // visibly tilt without claiming to be a real rating system.
  let rating = 1500
  const points: number[] = [rating]
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    rating += recent[i].is_win ? 12 : -10
    points.push(rating)
  }
  return points
}

function projectHeadToHead(
  seed: SeedMatch,
  priors: SeedMatch[],
): MatchDetailsH2H | null {
  if (seed.opponent === null) return null
  const opponentId = seed.opponent.id
  const completed = priors.filter(
    (m) => m.opponent !== null && m.opponent.id === opponentId,
  )
  const meetings: MatchDetailsH2HMeeting[] = []
  let side1Wins = 0
  let side2Wins = 0
  // The mock current-user always sits on side 1 of every past match (same
  // orientation as the current match), so per-row counts align with this
  // match's side numbers without remapping.
  for (const m of completed) {
    const { side1, side2 } = sideWinCounts(m)
    const winner = winnerOf(m)
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
  const nextNumber = currentGameNumber(seed)
  const scorable =
    (seed.status === 'pending' || seed.status === 'in_progress') &&
    nextNumber !== null
  return {
    id: seed.id,
    status: seed.status,
    status_label: seedStatusLabel(seed),
    league: MOCK_DEFAULT_LEAGUE,
    sides: [mySide, opponentSide],
    best_of: seed.best_of,
    created_at: seed.created_at,
    current_game_number: scorable ? nextNumber : null,
    can_score: scorable,
    can_confirm: canConfirmSeed(seed),
  }
}

export function projectScoreBanner(seed: SeedMatch): DashboardScoreBanner | null {
  const nextNumber = currentGameNumber(seed)
  if (seed.status !== 'in_progress' || nextNumber === null) return null
  return {
    match_id: seed.id,
    opponent_username: seed.opponent?.username ?? null,
    current_game_number: nextNumber,
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
      games: [],
      signatures: [],
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
      ],
      signatures: [],
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
      // Pre-signed completed match — both sides signed before completion.
      signatures: [
        { user_id: MOCK_CURRENT_USER.id, signed_at: '2026-05-10T18:42:00Z' },
        { user_id: 'pl-silva', signed_at: '2026-05-10T18:43:00Z' },
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
      signatures: [
        { user_id: 'pl-patel', signed_at: '2026-05-08T20:25:00Z' },
        { user_id: MOCK_CURRENT_USER.id, signed_at: '2026-05-08T20:26:00Z' },
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
      signatures: [
        { user_id: MOCK_CURRENT_USER.id, signed_at: '2026-05-06T19:20:00Z' },
        { user_id: 'pl-chen', signed_at: '2026-05-06T19:21:00Z' },
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
  const winner = Math.max(side1, side2)
  const loser = Math.min(side1, side2)
  if (winner < 11) return 'The winning side must reach at least 11 points.'
  if (side1 === side2) return 'A game cannot end in a tie.'
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

/** Hardcoded current-user id used by `POST /v1/matches` to populate side 1.
 * Games aren't pre-created — POST .../scores/new inserts them lazily. */
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
    games: [],
    signatures: [],
  }
  return seed
}

/** POST /v1/matches/{id}/results: obliterate the existing games + scores,
 * insert the payload's games, record the current user's signature, and
 * (for solo matches) flip status to completed. Non-solo matches stay at
 * ``in_progress`` until ``POST /confirmation`` lands the second signature.
 * Returns null on validation success, or a 422-suitable detail string. */
export function finalizeSeed(
  seed: SeedMatch,
  games: Array<{
    game_number: number
    side_1_points: number
    side_2_points: number
  }>,
): string | null {
  if (seed.signatures.length > 0) {
    return 'Result already posted; use /confirmation.'
  }
  if (games.length === 0) {
    return 'A match needs at least one game to finalize.'
  }
  const numbers = games.map((g) => g.game_number)
  if (numbers.some((n) => n > seed.best_of)) {
    return `Each game_number must be ≤ best_of (${seed.best_of}).`
  }
  if (new Set(numbers).size !== numbers.length) {
    return 'Duplicate game_number in payload.'
  }
  const sortedNumbers = numbers.slice().sort((a, b) => a - b)
  for (let i = 0; i < sortedNumbers.length; i += 1) {
    if (sortedNumbers[i] !== i + 1) {
      return 'Games must be numbered 1..N consecutively with no gaps.'
    }
  }
  for (const g of games) {
    const message = validateScore(g.side_1_points, g.side_2_points)
    if (message) return message
  }
  const ordered = games.slice().sort((a, b) => a.game_number - b.game_number)
  const target = gamesToWin(seed.best_of)
  let wins1 = 0
  let wins2 = 0
  let decidedAt: number | null = null
  let decidedSide: 1 | 2 | null = null
  for (const g of ordered) {
    if (g.side_1_points > g.side_2_points) wins1 += 1
    else wins2 += 1
    if (decidedSide === null && (wins1 >= target || wins2 >= target)) {
      decidedSide = wins1 >= target ? 1 : 2
      decidedAt = g.game_number
    }
  }
  if (decidedSide === null) {
    return `No side reached ${target} game wins — the match isn't decided.`
  }
  if (decidedAt !== ordered[ordered.length - 1].game_number) {
    return 'Scored games extend past the deciding game; drop any games after the decider.'
  }

  seed.games = ordered.map((g) => ({
    id: `g-${seed.id}-${g.game_number}`,
    game_number: g.game_number,
    score: {
      id: `s-${seed.id}-${g.game_number}`,
      side_1_points: g.side_1_points,
      side_2_points: g.side_2_points,
    },
  }))

  if (seed.opponent === null) {
    // Solo match — nobody else to sign, finalize immediately (mirror the API).
    seed.status = 'completed'
    seed.completed_at = new Date().toISOString()
  } else {
    seed.signatures.push({
      user_id: MOCK_CURRENT_USER.id,
      signed_at: new Date().toISOString(),
    })
  }
  return null
}

/** POST /v1/matches/{id}/confirmation: insert ``userId``'s signature. If
 * every side now has at least one signing player, flip the seed to
 * ``completed`` (mirroring ``_apply_rating_update``'s gate at the API).
 * Returns null on success, or a 409-suitable detail string. */
export function confirmSeed(seed: SeedMatch, userId: string): string | null {
  const guard = confirmableGuard(seed, userId)
  if (guard) return guard
  seed.signatures.push({
    user_id: userId,
    signed_at: new Date().toISOString(),
  })
  if (allSidesSigned(seed)) {
    seed.status = 'completed'
    seed.completed_at = new Date().toISOString()
  }
  return null
}

/** POST /v1/matches/{id}/dispute: clear every signature; reset side win
 * flags (derived in ``projectSides`` from ``signatures.length``, so just
 * clearing signatures is enough). Returns null on success, or a 409-suitable
 * detail string. */
export function disputeSeed(seed: SeedMatch, userId: string): string | null {
  const guard = confirmableGuard(seed, userId)
  if (guard) return guard
  seed.signatures = []
  return null
}

/** Shared preconditions for confirm + dispute. ``userId`` is the FE's mock
 * current user (handlers always pass MOCK_CURRENT_USER.id). Both endpoints
 * 404 for non-participants, but the FE/MSW only models the current user, so
 * we collapse to 409 for the user-facing cases (already signed, no result
 * posted yet, etc.). */
function confirmableGuard(seed: SeedMatch, userId: string): string | null {
  if (seed.opponent === null) {
    return "This match has no opponent and can't be signed."
  }
  if (seed.status !== 'in_progress') {
    return 'This match is no longer awaiting confirmation.'
  }
  if (seed.signatures.length === 0) {
    return 'No posted result to act on. Post the result first.'
  }
  if (seed.signatures.some((sig) => sig.user_id === userId)) {
    return "You've already signed this match."
  }
  return null
}

function allSidesSigned(seed: SeedMatch): boolean {
  // The mock only models singles, so side 1 is the current user and side 2
  // is the (single) opponent. With "at least one player per side" semantics
  // both users must appear in ``signatures``.
  const signers = new Set(seed.signatures.map((sig) => sig.user_id))
  if (!signers.has(MOCK_CURRENT_USER.id)) return false
  if (seed.opponent === null) return false
  return signers.has(seed.opponent.id)
}
