import type { components } from '@/api/schema'
import { compactGames, isDecidedMatch } from '@/lib/scoring'

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
type MatchNegotiation = components['schemas']['MatchNegotiation']
type NegotiationGame = components['schemas']['NegotiationGame']
type NegotiationResult = components['schemas']['NegotiationResult']
type NegotiationDiffEntry = components['schemas']['NegotiationDiffEntry']
type DashboardAttentionItem = components['schemas']['DashboardAttentionItem']
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
  voided: 'Voided',
}

const ALL_STATUSES: MatchStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'voided',
]

export type SeedGame = {
  id: string
  game_number: number
  score: {
    id: string
    side_1_points: number
    side_2_points: number
    // Optimistic-concurrency token. Optional in fixtures (defaults to 1 in
    // projection); the score-write handlers bump it on each PUT.
    version?: number
  } | null
}

/** One game snapshot inside a posted result — the immutable board the
 * proposer/acceptor agreed (or proposed). Mirrors the JSONB the API stores. */
export type SeedResultGame = {
  game_number: number
  side_1_points: number
  side_2_points: number
}

/** A posted result in the two-verb negotiation chain. A first proposal has
 * no `supersedes_result_id`; a counter sets it to the result it replaces. An
 * accepted result carries `accepted_by` (⟹ the match is final). */
export type SeedResult = {
  id: string
  submitted_by: string
  accepted_by?: string | null
  supersedes_result_id?: string | null
  games: SeedResultGame[]
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
  // The negotiation chain (linear): each ``POST /results`` appends one row.
  // Empty until the first proposal; an accepted row finalizes the match.
  results: SeedResult[]
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

// ----- negotiation chain derivation (mirrors api/app/matches.py) -----------

/** The head of the chain — the result nothing supersedes — or null. */
export function headResult(seed: SeedMatch): SeedResult | null {
  const superseded = new Set(
    seed.results
      .map((r) => r.supersedes_result_id)
      .filter((id): id is string => !!id),
  )
  return seed.results.find((r) => !superseded.has(r.id)) ?? null
}

/** The live, unaccepted proposal at the head of the chain, or null. */
export function standingResult(seed: SeedMatch): SeedResult | null {
  const head = headResult(seed)
  if (head !== null && !head.accepted_by) return head
  return null
}

/** The accepted (final) result, or null. */
export function acceptedResult(seed: SeedMatch): SeedResult | null {
  return seed.results.find((r) => !!r.accepted_by) ?? null
}

/** True iff the result was submitted by the mock current user (who always
 * sits on side 1 — the viewer's side). The backend checks "submitted_by is a
 * player on the viewer's side"; the singles mock collapses to this. */
function submittedByViewer(result: SeedResult): boolean {
  return result.submitted_by === MOCK_CURRENT_USER.id
}

function negotiationGame(g: SeedResultGame): NegotiationGame {
  return {
    game_number: g.game_number,
    side_1_points: g.side_1_points,
    side_2_points: g.side_2_points,
  }
}

// The mock doesn't track per-result timestamps; a stable ISO keeps the shape
// total without inventing a clock. The FE min slice never renders it.
const SEED_RESULT_AT = '2026-05-12T19:30:00Z'

function negotiationResultView(result: SeedResult): NegotiationResult {
  return {
    id: result.id,
    games: result.games
      .slice()
      .sort((a, b) => a.game_number - b.game_number)
      .map(negotiationGame),
    submitted_by: result.submitted_by,
    submitted_at: SEED_RESULT_AT,
  }
}

/** Viewer-relative diff between the viewer's own last proposal (baseline) and
 * the standing proposal. Emits an entry only for games whose points differ (or
 * that the baseline lacks → old=null), ordered by game number. Mirrors
 * `_negotiation_diff` in the API. */
function negotiationDiff(
  baseline: SeedResultGame[],
  standing: SeedResultGame[],
): NegotiationDiffEntry[] {
  const byNumber = new Map(baseline.map((g) => [g.game_number, g]))
  const entries: NegotiationDiffEntry[] = []
  for (const game of standing.slice().sort((a, b) => a.game_number - b.game_number)) {
    const old = byNumber.get(game.game_number)
    if (!old) {
      entries.push({
        game_number: game.game_number,
        old: null,
        new: negotiationGame(game),
      })
    } else if (
      old.side_1_points !== game.side_1_points ||
      old.side_2_points !== game.side_2_points
    ) {
      entries.push({
        game_number: game.game_number,
        old: negotiationGame(old),
        new: negotiationGame(game),
      })
    }
  }
  return entries
}

/** The neutral "no result posted yet" negotiation block — the default for a
 * fresh/live match. Test factories spread this so a `MatchDetails`/`MatchListRow`
 * fixture is total without re-spelling the block. */
export const LIVE_NEGOTIATION: MatchNegotiation = {
  viewer_state: 'live',
  your_turn: false,
  standing_result: null,
  prior_result: null,
  diff: null,
}

/** The viewer-relative negotiation block — mirrors `_negotiation` in the API.
 * The mock current user always sits on side 1 (the viewer's side). */
export function negotiationOf(seed: SeedMatch): MatchNegotiation {
  const accepted = acceptedResult(seed)
  if (accepted !== null) {
    return {
      viewer_state: 'final',
      your_turn: false,
      standing_result: negotiationResultView(accepted),
      prior_result: null,
      diff: null,
    }
  }

  const standing = standingResult(seed)
  if (standing === null) {
    return LIVE_NEGOTIATION
  }

  const standingView = negotiationResultView(standing)

  if (submittedByViewer(standing)) {
    // The viewer's own side proposed the standing result; await the opponent.
    return {
      viewer_state: 'awaiting',
      your_turn: false,
      standing_result: standingView,
      prior_result: null,
      diff: null,
    }
  }

  // The opponent submitted the standing result → the viewer must act. Walk the
  // supersede chain back to the viewer's own last proposal (the baseline that
  // collapses the opponent's intermediate self-edits).
  const byId = new Map(seed.results.map((r) => [r.id, r]))
  let prior: SeedResult | null = null
  let cursor = standing.supersedes_result_id ?? null
  while (cursor !== null) {
    const candidate = byId.get(cursor)
    if (!candidate) break
    if (submittedByViewer(candidate)) {
      prior = candidate
      break
    }
    cursor = candidate.supersedes_result_id ?? null
  }

  if (prior === null) {
    return {
      viewer_state: 'review',
      your_turn: true,
      standing_result: standingView,
      prior_result: null,
      diff: null,
    }
  }

  return {
    viewer_state: 'corrected',
    your_turn: true,
    standing_result: standingView,
    prior_result: negotiationResultView(prior),
    diff: negotiationDiff(prior.games, standing.games),
  }
}

/** Lowest 1..best_of game number with no saved score, or null when every
 * game in [1, best_of] is scored / the match isn't in progress. Mirrors the
 * server's ``current_game_number`` derivation in api/app/matches.py. */
function currentGameNumber(seed: SeedMatch): number | null {
  if (seed.status !== 'in_progress') return null
  // Any posted result freezes the scratchpad — no game is "current" once the
  // first result lands (mirrors the server's ``match.results`` check).
  if (seed.results.length > 0) return null
  // A decided board has no "next game to play" even if a slot in [1, best_of]
  // is still un-scored (a bo3 won 2-0 has no game 3). Mirrors the server's
  // decided-check.
  const target = gamesToWin(seed.best_of)
  const { side1, side2 } = sideWinCounts(seed)
  if (side1 >= target || side2 >= target) return null
  const scored = new Set(
    seed.games.filter((g) => g.score !== null).map((g) => g.game_number),
  )
  for (let n = 1; n <= seed.best_of; n += 1) {
    if (!scored.has(n)) return n
  }
  return null
}

/** Whether the saved scores are editable — frozen the instant the first
 * result is posted. Mirrors the server's ``_is_scorable``: a non-terminal
 * match with no posted result at all. (The mock seeds always carry two sides
 * and view the match as a participant.) */
function scorableSeed(seed: SeedMatch): boolean {
  return (
    seed.status !== 'completed' &&
    seed.status !== 'voided' &&
    seed.results.length === 0
  )
}

/** Whether the currently-saved scores form a complete, validly-ordered,
 * decided match — i.e. the FIRST ``POST /results`` would succeed against the
 * current scratchpad state. Mirrors the server's ``_can_finalize`` predicate,
 * including its compaction of a gappy-but-decided board (ADR 0002): an
 * out-of-order clinch that left a hole (e.g. ``[1,2,3,5]``) is closed up
 * before validating, so it reports finalizable just like the API. */
function canFinalizeSeed(seed: SeedMatch): boolean {
  if (seed.status !== 'in_progress') return false
  // Once any result is posted, accept/counter is the next action, not a first
  // propose. Mirrors the server's ``if match.results: return False``.
  if (seed.results.length > 0) return false
  const scored = seed.games
    .filter((g) => g.score !== null)
    .map((g) => ({
      game_number: g.game_number,
      side_1_points: g.score!.side_1_points,
      side_2_points: g.score!.side_2_points,
    }))
  if (scored.length === 0) return false
  return isDecidedMatch(compactGames(scored), seed.best_of)
}

function projectSides(seed: SeedMatch): {
  mySide: MatchDetailsSide
  // Always present: a real opponent, or the player-less sentinel side that
  // makes an opponent-less match scorable (mirrors the API).
  opponentSide: MatchDetailsSide
} {
  const { side1, side2 } = sideWinCounts(seed)
  // ``won`` is only stamped when the match completes — immediately at
  // /results for solo/unrated matches, at acceptance for rated ones
  // (issue #485). While a rated match awaits acceptance the outcome is
  // conveyed by the games, not an official W/L. Mirrors the API.
  const decided = seed.status === 'completed'

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
  if (seed.status === 'in_progress' && standingResult(seed) !== null) {
    return 'Awaiting acceptance'
  }
  return STATUS_LABELS[seed.status]
}

// Mirrors the backend scoreboard-status mapping (app/mappers/match_details_mapper.py):
// voided collapses to `final`, not `live`. Exported so the test factories
// derive `data.scoreboard.status` the same way instead of re-inlining it.
export function seedScoreboardStatus(
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
            version: g.score.version ?? 1,
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
    can_score: scorableSeed(seed),
    can_finalize: canFinalizeSeed(seed),
    negotiation: negotiationOf(seed),
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
      rated: m.affects_rating,
    })
  }
  return {
    total_meetings: meetings.length,
    side_1_wins: side1Wins,
    side_2_wins: side2Wins,
    recent_meetings: meetings.slice(0, H2H_LIMIT),
  }
}

type ListAttentionKind = NonNullable<MatchListRow['attention']>

/** The matches-list attention bucket for a seed — mirrors
 * `api/app/attention.py:list_attention_kind`. Unlike the dashboard classifier
 * it also surfaces the passive `waiting_*` buckets (the list shows them as quiet
 * rows). Null for a finished match (the mock treats every seed as the current
 * user's). */
export function listAttentionKind(seed: SeedMatch): ListAttentionKind | null {
  switch (seed.status) {
    case 'pending':
      return 'waiting_others'
    case 'in_progress': {
      const standing = standingResult(seed)
      if (standing !== null) {
        // Posted by me (side 1) → waiting on opponent; posted by them → review.
        return submittedByViewer(standing) ? 'waiting_opponent' : 'review'
      }
      return 'score'
    }
    default:
      return null
  }
}

// Priority for ranking the Attention tab — mirrors `attention_priority`.
const LIST_ATTENTION_PRIORITY: Record<ListAttentionKind, number> = {
  review: 1,
  // score splits rated (2) / unrated (3) — handled in `listAttentionRank`.
  score: 2,
  waiting_opponent: 4,
  waiting_others: 5,
}

function listAttentionRank(seed: SeedMatch, kind: ListAttentionKind): number {
  if (kind === 'score' && !seed.affects_rating) return 3
  return LIST_ATTENTION_PRIORITY[kind]
}

// The actionable buckets — the Attention tab's membership. An allow-list rather
// than a deny-list of the passive kinds, so a future `ListAttentionKind` added
// to the union stays out of the tab until it's explicitly opted in here (a new
// *waiting* kind can't silently leak in). Mirrors the server's
// `_actionable_attention_filter` (issue #729).
const ACTIONABLE_LIST_KINDS: ReadonlySet<ListAttentionKind> =
  new Set<ListAttentionKind>(['review', 'score'])

/** The Attention tab's row set: the current user's *actionable* open matches,
 * ranked by urgency then oldest-first — mirrors the BFF's attention path. Only
 * the actionable buckets are members; the passive waiting rows (`waiting_opponent`
 * — my posted result awaiting the opponent — and `waiting_others` — a pending
 * match) are excluded so the tab is viewer-relative (issue #729). */
export function rankAttentionSeeds(seeds: SeedMatch[]): SeedMatch[] {
  return seeds
    .flatMap((seed) => {
      const kind = listAttentionKind(seed)
      return kind !== null && ACTIONABLE_LIST_KINDS.has(kind)
        ? [{ seed, rank: listAttentionRank(seed, kind) }]
        : []
    })
    .sort(
      (a, b) =>
        a.rank - b.rank || a.seed.created_at.localeCompare(b.seed.created_at),
    )
    .map((row) => row.seed)
}

export function projectListRow(seed: SeedMatch): MatchListRow {
  const { mySide, opponentSide } = projectSides(seed)
  const nextNumber = currentGameNumber(seed)
  return {
    id: seed.id,
    status: seed.status,
    status_label: seedStatusLabel(seed),
    league: MOCK_DEFAULT_LEAGUE,
    sides: [mySide, opponentSide],
    best_of: seed.best_of,
    affects_rating: seed.affects_rating,
    created_at: seed.created_at,
    // The next-playable-game deep-link target (null when decided/posted); the
    // editable flag follows the no-result rule independently of it.
    current_game_number: nextNumber,
    can_score: scorableSeed(seed),
    negotiation: negotiationOf(seed),
    attention: listAttentionKind(seed),
  }
}

// Attention classification — mirrors api/app/dashboard.py (PRD §5). Returns the
// bucket plus its priority (lower = more urgent) in one pass, or null when the
// seed isn't an actionable row for the current user (waiting / pending /
// finished).
function classifyAttention(
  seed: SeedMatch,
): { kind: DashboardAttentionItem['kind']; priority: number } | null {
  if (seed.status === 'in_progress') {
    const standing = standingResult(seed)
    if (standing !== null) {
      // Posted by me → waiting on opponent (footer); posted by them → my review.
      return submittedByViewer(standing) ? null : { kind: 'review', priority: 1 }
    }
    return { kind: 'score', priority: seed.affects_rating ? 2 : 3 }
  }
  return null
}

/** Classify a single seed into a dashboard attention row, or null when it's
 * not actionable for the current user (waiting / pending / finished). */
export function projectAttention(seed: SeedMatch): DashboardAttentionItem | null {
  const classified = classifyAttention(seed)
  if (classified === null) return null
  return {
    match_id: seed.id,
    opponent_username: seed.opponent?.username ?? null,
    kind: classified.kind,
    affects_rating: seed.affects_rating,
    current_game_number:
      classified.kind === 'score' ? currentGameNumber(seed) : null,
  }
}

/** Whether a seed is "waiting on others" — a result I posted awaiting the
 * opponent, or a pending/scheduled match. Footer count only, never a row. */
export function isWaitingSeed(seed: SeedMatch): boolean {
  if (seed.status === 'pending') return true
  if (seed.status !== 'in_progress') return false
  const standing = standingResult(seed)
  return standing !== null && submittedByViewer(standing)
}

// Mirrors the BFF's `ATTENTION_BANNERS_LIMIT`: the panel only renders a few
// rows, so the server caps the eager-loaded set and reports the true total
// separately (see api/app/dashboard.py).
const ATTENTION_BANNERS_LIMIT = 10

/** Build the dashboard attention payload from all seeds, pre-ranked oldest-
 * first within each priority bucket — mirrors the BFF's `_build_attention`.
 * The row list is capped at `ATTENTION_BANNERS_LIMIT`; `attention_total_count`
 * carries the full actionable total so the footer's "+N more" stays exact. */
export function projectDashboardAttention(seeds: SeedMatch[]): {
  attention: DashboardAttentionItem[]
  attention_total_count: number
  waiting_count: number
} {
  const ranked = seeds
    .map((seed) => ({ seed, classified: classifyAttention(seed) }))
    .filter(
      (
        row,
      ): row is {
        seed: SeedMatch
        classified: { kind: DashboardAttentionItem['kind']; priority: number }
      } => row.classified !== null,
    )
    .sort(
      (a, b) =>
        a.classified.priority - b.classified.priority ||
        a.seed.created_at.localeCompare(b.seed.created_at),
    )
  const attention = ranked.flatMap((row) => {
    const item = projectAttention(row.seed)
    return item ? [item] : []
  })
  return {
    attention: attention.slice(0, ATTENTION_BANNERS_LIMIT),
    attention_total_count: attention.length,
    waiting_count: seeds.filter(isWaitingSeed).length,
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
 * shape MSW and prod return.
 *
 * **`null` when no rated match has been finished** (#950). This mock used to
 * hand every caller a card starting at `MOCK_BASE_RATING` — current 1500, peak
 * 1500, a one-point sparkline — for a user who had played nothing, which is a
 * shape the API does not send and never did claim to: joining a league seeds
 * `rating_value` as the strategy's *prior*, and `DashboardResponse.rating` is
 * `null` for a player who has never finished a rated match (`CONTEXT.md` §
 * *Rating*). A mock that models a rating the server withholds is how a 1500 on a
 * brand-new dashboard survived the entire suite; it now models the withholding. */
export function projectRating(seeds: SeedMatch[]): DashboardRating | null {
  const completed = seeds
    .filter(
      (s): s is SeedMatch & { completed_at: string } =>
        s.status === 'completed' &&
        s.completed_at !== null &&
        s.opponent !== null &&
        s.affects_rating,
    )
    .sort((a, b) => a.completed_at.localeCompare(b.completed_at))

  // Never finished a rated match ⇒ no rating, and so no rating card at all —
  // not a card seeded at the strategy's prior.
  if (completed.length === 0) return null

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
    // Unconditional now: the zero-match case returned above, and a rated player
    // has a ladder position. (This ternary used to be the one place that noticed
    // an unplayed player had no business holding a percentile — #382 — while the
    // other four figures printed the prior anyway.)
    percentile: 72,
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

/** A posted-but-unaccepted result: an in_progress seed with a standing result.
 * Mirrors the server's "Awaiting acceptance" bucket (issue #381). */
export function isAwaitingAcceptance(seed: SeedMatch): boolean {
  return seed.status === 'in_progress' && standingResult(seed) !== null
}

/** Count of awaiting-acceptance seeds — its own bucket, peeled out of the
 * in_progress status count so Live reads as true-live. */
export function awaitingCountOf(seeds: SeedMatch[]): number {
  return seeds.filter(isAwaitingAcceptance).length
}

/** Single source of truth for the per-status histogram returned alongside
 * the paginated list — the FE renders pill counts from this. The in_progress
 * count is true-live only: awaiting-acceptance seeds are split out into
 * `awaitingCountOf` (issue #381). */
export function statusCountsOf(seeds: SeedMatch[]): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(
    ALL_STATUSES.map((s) => [s, 0]),
  )
  for (const s of seeds) {
    if (isAwaitingAcceptance(s)) continue
    counts[s.status] = (counts[s.status] ?? 0) + 1
  }
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
      results: [],
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
      results: [],
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
      // Accepted result — the current user proposed, the opponent accepted.
      results: [
        {
          id: 'r-cw-1',
          submitted_by: MOCK_CURRENT_USER.id,
          accepted_by: 'pl-silva',
          games: completedGames([
            [1, 11, 7],
            [2, 11, 9],
            [3, 8, 11],
            [4, 12, 10],
          ]),
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
      results: [
        {
          id: 'r-cl-1',
          submitted_by: 'pl-patel',
          accepted_by: MOCK_CURRENT_USER.id,
          games: completedGames([
            [1, 6, 11],
            [2, 9, 11],
          ]),
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
      results: [
        {
          id: 'r-cw-2',
          submitted_by: MOCK_CURRENT_USER.id,
          accepted_by: 'pl-chen',
          games: completedGames([
            [1, 11, 4],
            [2, 11, 6],
          ]),
        },
      ],
    },
  ]
}

/** Tuple → SeedResultGame helper for the seed fixtures. */
function completedGames(
  rows: Array<[number, number, number]>,
): SeedResultGame[] {
  return rows.map(([game_number, side_1_points, side_2_points]) => ({
    game_number,
    side_1_points,
    side_2_points,
  }))
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
    results: [],
  }
  return seed
}

let resultSeq = 0
function nextResultId(): string {
  resultSeq += 1
  return `r-${Date.now().toString(36)}-${resultSeq}`
}

/** Validate a proposed board against the same rules the API enforces in
 * `_validate_finalize_games`. Returns null on success, or a 422-suitable
 * detail string. */
function validateProposedGames(
  seed: SeedMatch,
  games: SeedResultGame[],
): string | null {
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
  for (const g of ordered) {
    if (g.side_1_points > g.side_2_points) wins1 += 1
    else wins2 += 1
    if (decidedAt === null && (wins1 >= target || wins2 >= target)) {
      decidedAt = g.game_number
    }
  }
  if (decidedAt === null) {
    return `No side reached ${target} game wins — the match isn't decided.`
  }
  if (decidedAt !== ordered[ordered.length - 1].game_number) {
    return 'Scored games extend past the deciding game; drop any games after the decider.'
  }
  return null
}

/** Stamp the seed's scratchpad games from a proposed board, so the scoreboard
 * renders the proposed snapshot (mirrors `_commit_canonical_games`). */
function syncScratchpadGames(seed: SeedMatch, games: SeedResultGame[]): void {
  seed.games = games
    .slice()
    .sort((a, b) => a.game_number - b.game_number)
    .map((g) => ({
      id: `g-${seed.id}-${g.game_number}`,
      game_number: g.game_number,
      score: {
        id: `s-${seed.id}-${g.game_number}`,
        side_1_points: g.side_1_points,
        side_2_points: g.side_2_points,
      },
    }))
}

/** POST /v1/matches/{id}/results — the propose verb. A first proposal omits
 * `supersedesResultId` (requires no result exists); a counter sets it to the
 * standing result's id. Solo/unrated matches self-accept immediately; rated
 * two-human matches leave the result standing for the opposing side to accept.
 * Returns null on success, or `{ status, message }` for an error response. */
export function proposeSeed(
  seed: SeedMatch,
  games: SeedResultGame[],
  supersedesResultId: string | null,
): { status: number; message: string } | null {
  // Strict decided-board precondition (422), before the negotiation gates.
  const validationError = validateProposedGames(seed, games)
  if (validationError) return { status: 422, message: validationError }

  if (supersedesResultId === null) {
    // First proposal: require no result exists yet.
    if (seed.results.length > 0) {
      return {
        status: 409,
        message: 'This match already has a posted result.',
      }
    }
  } else {
    // Counter: must target the current standing result.
    const standing = standingResult(seed)
    if (standing === null || standing.id !== supersedesResultId) {
      return {
        status: 409,
        message: 'The result you are countering is no longer standing.',
      }
    }
  }

  syncScratchpadGames(seed, games)

  const result: SeedResult = {
    id: nextResultId(),
    submitted_by: MOCK_CURRENT_USER.id,
    supersedes_result_id: supersedesResultId,
    games: games.slice().sort((a, b) => a.game_number - b.game_number),
  }

  const requiresAcceptance = seed.opponent !== null && seed.affects_rating
  if (!requiresAcceptance) {
    // Solo / unrated: the proposer self-accepts and the match finalizes.
    result.accepted_by = MOCK_CURRENT_USER.id
    seed.results.push(result)
    seed.status = 'completed'
    seed.completed_at = new Date().toISOString()
  } else {
    // Rated two-human: leave standing for the opposing side to accept.
    seed.results.push(result)
    seed.status = 'in_progress'
  }
  return null
}

/** POST /v1/matches/{id}/results/{result_id}/acceptance — the accept verb.
 * `resultId` is the concurrency token: it must equal the current standing
 * result's id. `userId` is the accepting participant (the opposing side).
 * Returns null on success, or `{ status, message }` for an error. */
export function acceptSeed(
  seed: SeedMatch,
  resultId: string,
  userId: string,
): { status: number; message: string } | null {
  // 404 when no result with that id exists on the match.
  const target = seed.results.find((r) => r.id === resultId)
  if (!target) {
    return { status: 404, message: 'No such result on this match.' }
  }
  const standing = standingResult(seed)
  if (standing === null || standing.id !== resultId) {
    return {
      status: 409,
      message: 'This proposal is no longer standing.',
    }
  }
  // The proposing side already consented; only the opposing side may accept.
  if (standing.submitted_by === userId) {
    return { status: 409, message: "You can't accept your own proposal." }
  }
  standing.accepted_by = userId
  seed.status = 'completed'
  seed.completed_at = new Date().toISOString()
  // `won` is derived in projectSides from status==completed + the board; the
  // decided side is implicit in the saved games, so nothing else to touch.
  return null
}
