import { delay, http, HttpResponse } from 'msw'
import {
  DEFAULT_RATING_RANGE,
  RATING_RANGES,
  type RatingHistoryWindow,
  type RatingRange,
} from '@/api/players'
import type { components } from '@/api/schema'
import { healthCheck, player, sessionResponse } from '@/test/factories'
import {
  FORTYMM_LEAGUE_ID,
  USATT_LEAGUE_ID,
} from './factories/players/player-league.factory'
import {
  buildEstablishedRatingChange,
  buildRatingChange,
} from './factories/players/rating-change.factory'
import {
  acceptSeed,
  proposeSeed,
  findMatch,
  MOCK_CURRENT_USER,
  awaitingCountOf,
  isAwaitingAcceptance,
  mockMatches,
  newMatchSeed,
  projectDashboardAttention,
  projectListRow,
  projectMatchDetails,
  projectRating,
  projectRecentResult,
  rankAttentionSeeds,
  statusCountsOf,
  validateScore,
  type SeedMatch,
} from './match-store'
import {
  buildAdminSolveLedgerSeed,
  pageAdminScheduleSolves,
} from './factories/tournaments/tournament.factory'
import { buildDashboardTournament } from './factories/dashboard/tournament.factory'
import { buildAgentAccess } from './factories/settings/agent-access.factory'
import { mockUuid } from './mock-uuid'
import { PARKED_STREAM_BODY, SSE_CONTENT_TYPE } from './realtime-stream'
import { notificationHandlers } from './notifications-store'
import { createRbacState, dispatchRbac, type RbacState } from './rbac-engine'
import { DEMO_SEED } from './rbac-store'
import {
  createEvent as createTournamentEvent,
  createTournament,
  cutDraw as cutTournamentDraw,
  deleteEvent as deleteTournamentEvent,
  deleteTournament as deleteTournamentSeed,
  enterEvent as enterTournamentEvent,
  findTournament,
  listTournaments,
  namedList,
  type NearMeFilter,
  placeFixture as placeTournamentFixture,
  requestScheduleSolve as requestTournamentScheduleSolve,
  transitionTournament,
  uncutDraw as uncutTournamentDraw,
  updateEvent as updateTournamentEvent,
  updateTournament,
  withdrawEntry as withdrawTournamentEntry,
} from './tournaments-store'
import {
  cancelPreview as cancelSchedulePreview,
  enqueuePreview as enqueueSchedulePreview,
  readPreview as readSchedulePreview,
} from './schedule-preview-store'
import { PERM } from '@/lib/permissions'

// The signed-in mock user's id, shared by the session, the roster's "me" row
// and match-store's MOCK_CURRENT_USER — so the user menu's "Your profile" link
// (which reads `session.user.id`) lands on a mock profile that exists.
const MOCK_CURRENT_PLAYER_ID = 'u-me'

export const mockSession = sessionResponse({
  user: {
    id: MOCK_CURRENT_PLAYER_ID,
    username: 'rita.kovac',
    // The Administration nav *section* is gated on ADMIN_VIEW (app-shell), and
    // its children on their own permission. Grant ADMIN_VIEW so the section
    // expands, AUTH_MANAGE for the RBAC pages, TOURNAMENT_VIEW +
    // TOURNAMENT_CREATE so the Tournaments item appears, its page loads, and the
    // "New tournament" action shows, TOURNAMENT_ENTER so the dev user is a beta
    // tester who can self-register into a singles event, and
    // NOTIFICATIONS_BROADCAST so the Broadcast item appears and its (now
    // permission-gated) tool renders under `npm run dev`, and SCHEDULING_VIEW
    // so the Scheduling item appears and the solve-ledger page loads.
    permissions: [
      PERM.ADMIN_VIEW,
      PERM.AUTH_MANAGE,
      PERM.TOURNAMENT_VIEW,
      PERM.TOURNAMENT_CREATE,
      PERM.TOURNAMENT_ENTER,
      PERM.NOTIFICATIONS_BROADCAST,
      PERM.SCHEDULING_VIEW,
    ],
  },
})
export const mockHealthy = healthCheck()

/**
 * The dev world's Claude access state, as it starts. Swap `state` (and/or null
 * out `connector`) to walk `/settings/claude` through its six status rows
 * without a backend.
 */
export const MOCK_AGENT_ACCESS = buildAgentAccess({
  state: 'ready',
  username: mockSession.data.user.username,
  email: 'rita.kovac@example.com',
  connected_on: null,
})

/**
 * …and as it stands now, because one of those rows has a **write** behind it.
 * The `revoked` row's only affordance is "Allow Claude to connect", and a dev
 * world that answered the POST but kept serving `revoked` on the next read
 * would make the one control that matters look broken. Seed
 * `MOCK_AGENT_ACCESS` with `state: 'revoked'` and the button walks the whole
 * round trip.
 */
let agentAccessNow = MOCK_AGENT_ACCESS

/** The dev world's cross-tournament solve ledger (see the handler below). */
const mockAdminSolveLedger = buildAdminSolveLedgerSeed()

export const mockPlayers = [
  player({ username: 'nguyen.t', rating: 1842 }),
  player({ username: 'okafor.d', rating: 1721 }),
  player({ username: 'silva.r', rating: 1605 }),
  player({ username: 'patel.m', rating: 1933 }),
  player({ username: 'johansen.a', rating: 1488 }),
  player({ username: 'chen.w', rating: 1547 }),
  player({ username: 'park.j', rating: null }),
]

/**
 * The roster players who have **never played a match** — the shape production is
 * full of, and the one the mock world could not express, which is how a
 * never-played player reached the real stack rendering a 1500 rating, a 1500
 * peak, a rank above real players and a confidence card guessing they were
 * "somewhere between 814 and 2186".
 *
 * Joining a league seeds a rating internally, so `rating_value` is never null in
 * the database — but that seed is a *prior*, not a played result, and the API
 * does not send it. For a player who has finished no rated match, `rating`,
 * `rank`, `rank_of`, `percentile`, `peak`, `rating_delta` and `confidence` are
 * all `null`, `rating_history` is a wholly empty window and their league row
 * carries a `null` rating. And for one who has finished *nothing at all* — this
 * set — the record is empty too: no wins, no losses, no form, an empty career and
 * no matches. They have met nobody, so they have no head-to-head record either.
 *
 * Everything below derives from this one set, so the mock cannot quietly hand a
 * never-played player a record (or a rating) again. `park.j` is that player under
 * `npm run dev`: open their profile and every Unrated state on the page is
 * reachable by eye.
 */
const NEVER_PLAYED_USERNAMES = new Set(['park.j'])

/** Whether this roster player has ever played a match at all. See
 * `NEVER_PLAYED_USERNAMES` — the mock's model of the API's "unrated" rule. */
function hasPlayed(p: { username: string }): boolean {
  return !NEVER_PLAYED_USERNAMES.has(p.username)
}

/** The picker's recent-opponents grid — **opponents the caller has actually
 * played**, capped at six chips (mirrors `list_recent_opponents` in
 * `api/app/players.py`, which "returns only real opponents … so the picker never
 * presents strangers as recent opponents", #167).
 *
 * A player who has played nobody can therefore never appear here — filtering them
 * out is the contract, not an accident of the slice. They are still reachable in
 * the picker through **search**, which is where a `null`-rating chip shows up in
 * dev: type "park" on /matches/new and the chip reads "REGISTERED PLAYER" instead
 * of a rating. */
export const mockRecentOpponents = mockPlayers.filter(hasPlayed).slice(0, 6)

// Re-exported so consumers can import the store from one place.
export { mockMatches }

const state = createRbacState(DEMO_SEED)

// Mirrors the API's `_player_username_filter`: substring-match against *any*
// participant on the match, not just the opponent. Side 1 is always the mock
// current user (see match-store), so without this the dashboard's new
// `?q=<my-username>` deep-links match zero rows in MSW. Read the username
// off `mockSession` so the filter follows PATCH /v1/me — otherwise renaming
// yourself via /settings would silently stop matching your own matches.
function matchHasPlayerLike(m: SeedMatch, q: string): boolean {
  return (
    mockSession.data.user.username.toLowerCase().includes(q) ||
    (m.opponent?.username ?? '').toLowerCase().includes(q)
  )
}

/** Whether a seed falls in the requested `MatchListFilter` bucket. `in_progress`
 * (Live) excludes posted-but-unaccepted results; `awaiting_acceptance` is
 * exactly those — mirrors the server split so a posted result never leaks into
 * Live (issue #381). Shared by the list and CSV handlers. */
function matchesListFilter(m: SeedMatch, statusFilter: string): boolean {
  if (statusFilter === 'awaiting_acceptance') {
    return isAwaitingAcceptance(m)
  }
  if (statusFilter === 'in_progress') {
    return m.status === 'in_progress' && !isAwaitingAcceptance(m)
  }
  return m.status === statusFilter
}

// ----- /v1/players helpers --------------------------------------------------
//
// The dev/test mock roster + summary projector. Keeps the current user
// (rita.kovac, MOCK_CURRENT_USER) findable so /players/$myId resolves, and
// derives plausible W-L + form deterministically so reloads stay stable.

type PlayerSummary = components['schemas']['PlayerSummary']
type PlayerDetail = components['schemas']['PlayerDetail']
type PlayerCareer = components['schemas']['PlayerCareer']
type PlayerMatchRow = components['schemas']['PlayerMatchRow']

/** Mirrors `FORM_WINDOW` in `api/app/players.py` — the wire carries TEN recent
 * results, because the profile is where a player is actually studied. `form`
 * lives on the shared `PlayerSummary`, so the `/players` roster receives all ten
 * too and slices the first five for its dots column. Synthesizing five here
 * would hide that slice from every test (the real API sends ten). */
const FORM_WINDOW = 10

/** Mirrors `PERCENTILE_MIN_RATED_PLAYERS` in `api/app/players.py`: below this
 * many rated players the API withholds `percentile` entirely, because "top 8%"
 * in a twelve-player league only ever means "you are first". The mock roster is
 * far smaller than this, so mock profiles carry `percentile: null` — exactly
 * what the real API sends today. */
const PERCENTILE_MIN_RATED_PLAYERS = 50

function mockPlayerRoster() {
  const me = {
    id: MOCK_CURRENT_PLAYER_ID,
    username: mockSession.data.user.username,
    rating: 1820,
  }
  return [me, ...mockPlayers]
}

function djb2(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

/** Global rating rank (1 = highest) keyed by player id, derived from the whole
 * mock roster. Rated players are sorted by rating descending and numbered
 * 1-based; an unrated player (null rating, e.g. `park.j`) maps to `null`. This
 * mirrors the real `rank` field the API projects, so the roster renders true
 * ranks instead of page-index numbering (#841). Memoized — the roster is
 * static. */
let rankByIdCache: Map<string, number> | null = null
function rosterRankById(): Map<string, number> {
  if (rankByIdCache) return rankByIdCache
  const map = new Map<string, number>()
  // Standard competition ranking, mirroring the API's SQL `RANK()`: equal
  // ratings share a rank and the next rank skips (…, 7, 7, 9, …). Unrated
  // players are simply absent — callers read `.get(id) ?? null`.
  let prevRating: number | null = null
  let prevRank = 0
  mockPlayerRoster()
    .filter((p) => p.rating != null)
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
    .forEach((p, i) => {
      const rank = p.rating === prevRating ? prevRank : i + 1
      map.set(p.id, rank)
      prevRating = p.rating ?? null
      prevRank = rank
    })
  rankByIdCache = map
  return map
}

function summarizePlayer(p: {
  id: string
  username: string
  rating?: number | null
}): PlayerSummary {
  const rating = p.rating ?? null
  const rank = rosterRankById().get(p.id) ?? null
  // The current user gets real W-L derived from `mockMatches` so the
  // self-profile feels live. Everyone else gets deterministic synthesis
  // seeded by username — stable across reloads.
  if (p.id === MOCK_CURRENT_PLAYER_ID) {
    const completed = mockMatches.filter((m) => m.status === 'completed')
    let wins = 0
    let losses = 0
    const recent: ('W' | 'L')[] = []
    const sorted = completed.slice().sort((a, b) =>
      (b.completed_at ?? b.created_at).localeCompare(
        a.completed_at ?? a.created_at,
      ),
    )
    for (const m of sorted) {
      // Side 1 is always the current user in mocks (see match-store).
      let s1 = 0
      let s2 = 0
      for (const g of m.games) {
        if (!g.score) continue
        if (g.score.side_1_points > g.score.side_2_points) s1 += 1
        else if (g.score.side_2_points > g.score.side_1_points) s2 += 1
      }
      const target = Math.ceil(m.best_of / 2)
      if (s1 >= target) {
        wins += 1
        if (recent.length < FORM_WINDOW) recent.push('W')
      } else if (s2 >= target) {
        losses += 1
        if (recent.length < FORM_WINDOW) recent.push('L')
      }
    }
    return {
      id: p.id,
      username: p.username,
      rating,
      rank,
      wins,
      losses,
      form: recent.join(''),
    }
  }
  // A player who has never played has no record to synthesize. Their W-L and form
  // are read off the matches they actually have — which is none, so: no wins, no
  // losses, and an EMPTY form string rather than ten fabricated dots. Career, the
  // roster's dots column and the match list all fall out of the same rows, so
  // they cannot disagree with each other the way a hash-synthesized record did
  // (a career claiming 20 decided matches over an empty match list).
  //
  // Deriving rather than hard-coding zeroes also keeps them honest if you start a
  // match against them in `npm run dev`: the row lands in their history and their
  // record follows it.
  if (!hasPlayed(p)) {
    return {
      id: p.id,
      username: p.username,
      rating,
      rank,
      ...recordFromRows(projectPlayerMatches(p)),
    }
  }
  const seed = djb2(p.username)
  const wins = 5 + (seed % 25)
  const losses = 2 + ((seed * 7) % 12)
  const form = Array.from({ length: FORM_WINDOW }, (_, i) =>
    (seed + i * 3) % 3 === 0 ? 'L' : 'W',
  ).join('')
  return {
    id: p.id,
    username: p.username,
    rating,
    rank,
    wins,
    losses,
    form,
  }
}

/** A player's record as their *matches* tell it: wins, losses and the form window
 * (newest first, decided matches only — an undecided match is not a result). The
 * one place W-L and form are computed from rows, so a profile's career can never
 * disagree with the match list printed beneath it. */
function recordFromRows(rows: PlayerMatchRow[]): {
  wins: number
  losses: number
  form: string
} {
  const decided = rows.filter(
    (row): row is PlayerMatchRow & { result: 'W' | 'L' } => row.result !== null,
  )
  return {
    wins: decided.filter((row) => row.result === 'W').length,
    losses: decided.filter((row) => row.result === 'L').length,
    form: decided
      .slice(0, FORM_WINDOW)
      .map((row) => row.result)
      .join(''),
  }
}

/** Mirrors the backend's `PROFILE_RECENT_MATCHES` in `api/app/players.py` —
 * the profile bundle is an *overview*: it embeds only the six most recent
 * matches. The full 25-per-page history is its own surface
 * (`/players/{id}/matches`), fed by `/v1/players/{id}/matches`. */
const PROFILE_RECENT_MATCHES = 6

/** The hero's standing block — profile-only (it deliberately does NOT ride on
 * `PlayerSummary`, which the roster also serializes). Mirrors `_load_standing`
 * in `api/app/players.py`:
 *
 * - an **unrated** player (never finished a rated match) has no rank, and so no
 *   peak, no ladder position and no rating delta — `null` all the way down;
 * - a rated player's rank is reported *out of the rated population* (`rank_of`),
 *   so the hero can read "#3 of 42" instead of a flattering naked "#3";
 * - `rating_delta` is `null`, never a zero-delta object, when there is no
 *   preceding rated match to have moved the rating.
 */
/** The API's confidence cut points (`app.ratings.confidence`), mirrored: both are
 * inclusive floors on the Glicko-2 deviation, and the interval is `rating ±
 * 1.96·RD`. There is deliberately no confidence *percentage* — that number does
 * not exist. */
const PROVISIONAL_RD_FLOOR = 160
const FIRMING_UP_RD_FLOOR = 90
const INTERVAL_Z = 1.96

/** A rated mock player's confidence, seeded off their name so it is stable across
 * reloads. Spreads the three levels across the roster so `npm run dev` shows a
 * Provisional, a Firming up and a Settled card rather than a page of clones. */
function playerConfidence(
  rating: number,
  seed: number,
): components['schemas']['RatingConfidence'] {
  const deviation = 45 + (seed % 180)
  const level =
    deviation >= PROVISIONAL_RD_FLOOR
      ? 'provisional'
      : deviation >= FIRMING_UP_RD_FLOOR
        ? 'firming_up'
        : 'settled'
  const half = Math.round(INTERVAL_Z * deviation)
  return {
    level,
    deviation,
    volatility: 0.06 + (seed % 10) / 1000,
    interval: { low: rating - half, high: rating + half },
  }
}

function playerStanding(summary: PlayerSummary, rows: PlayerMatchRow[]) {
  const ratedPopulation = rosterRankById().size
  if (summary.rating == null || summary.rank == null) {
    // No rating means nothing to be confident *about* — the profile's confidence
    // card must not render at all for them.
    return {
      peak: null,
      rank_of: null,
      percentile: null,
      rating_delta: null,
      confidence: null,
    }
  }
  const seed = djb2(summary.username)
  return {
    peak: summary.rating + (seed % 40),
    rank_of: ratedPopulation,
    // The mock roster is a dozen players — far below the threshold at which a
    // percentile means anything, so the API would withhold it. Mirror that.
    percentile:
      ratedPopulation >= PERCENTILE_MIN_RATED_PLAYERS
        ? Math.max(
            1,
            Math.round((summary.rank / ratedPopulation) * 100),
          )
        : null,
    // Read straight off the player's own rows (newest first), not synthesized
    // beside them: the hero's Δ chip and the top row of the Recent-matches card
    // are two views of the SAME match, and a mock that made them up separately
    // could show a chip for a match whose Δ column says `—`. When that most-recent
    // rated match was the player's *first*, this is an ESTABLISHED change (null
    // `delta`) and the chip is suppressed entirely — they got rated, they did not
    // gain or lose (#952).
    rating_delta: rows.find((r) => r.rating_change !== null)?.rating_change ?? null,
    confidence: playerConfidence(summary.rating, seed),
  }
}

/** The player's **cross-league** career (ADR-0915) — a fact about the *person*,
 * so it deliberately ignores the requested league. Mirrors `_load_career` in
 * `api/app/career.py`:
 *
 * - `decided` counts only *decided* matches (a win or a loss), which is why it
 *   is smaller than the all-inclusive `match_total` whenever a match is in play.
 *   The two numbers sit side by side on the profile and differ on purpose;
 * - `win_rate` and `games_won_pct` are **shares in [0, 1]** — 0.686, never 68.6
 *   — despite the `_pct` name the API kept;
 * - a player who has decided nothing gets `null` shares and `null` streaks, not
 *   zeroes: a 0% would claim they lose every match they play.
 */
function playerCareer(summary: PlayerSummary): PlayerCareer {
  const decided = summary.wins + summary.losses
  if (decided === 0) {
    return {
      decided: 0,
      wins: 0,
      losses: 0,
      win_rate: null,
      games_won_pct: null,
      current_streak: null,
      best_streak: null,
      // Their league count, like everyone's, is a count of *memberships* — not of
      // the leagues they have played a match in. A player joins the default league
      // on sign-up, so this is never 0, and it must agree with `leagues.length` on
      // the same bundle whatever their record. Hard-coding a 1 here would put two
      // rows in the Leagues card under a Career card reading "1 league".
      league_count: MOCK_LEAGUES.length,
    }
  }
  const seed = djb2(summary.username)
  // Form is newest-first, so the current streak is its leading run of one
  // outcome — it breaks the moment the other one lands.
  const results = summary.form.split('')
  const kind = results[0] === 'L' ? ('L' as const) : ('W' as const)
  let run = 0
  while (run < results.length && results[run] === kind) run += 1
  // The real API scans the whole history for the best *winning* run; the mock
  // synthesizes one deterministically, never shorter than the current one.
  const bestWinRun = Math.max(kind === 'W' ? run : 0, 3 + (seed % 5))
  return {
    decided,
    wins: summary.wins,
    losses: summary.losses,
    win_rate: summary.wins / decided,
    // A share in [0, 1], deliberately not equal to the match win rate: games
    // won is a finer read on dominance than whole matches.
    games_won_pct: Math.round((0.4 + (seed % 35) / 100) * 1000) / 1000,
    current_streak: run > 0 ? { kind, n: run } : null,
    // No wins, no winning run to have been anyone's best.
    best_streak:
      summary.wins > 0 ? { kind: 'W' as const, n: bestWinRun } : null,
    // Career is CROSS-LEAGUE (ADR-0915), so this counts every ladder the player
    // belongs to — and it must agree with `leagues.length` on the same bundle,
    // exactly as the API guarantees (both are counted off league *memberships*).
    // The mock roster puts everyone in both leagues, so the Leagues card is a
    // switcher you can actually drive in `npm run dev`.
    league_count: MOCK_LEAGUES.length,
  }
}

/** The mock leagues. Ids are **uuids**, as the wire carries them — the profile
 * route validates `?league=` as one, so a `'usatt'`-style id here would be caught
 * at the boundary and silently degrade to the default league.
 *
 * Every mock player belongs to both. In production today every player is in
 * exactly one (there is no join-league endpoint yet), and the card correctly
 * renders a single row for them — but a one-league mock would leave the switcher
 * undrivable in dev. */
const MOCK_LEAGUES = [
  { id: FORTYMM_LEAGUE_ID, name: 'FortyMM', is_default: true },
  { id: USATT_LEAGUE_ID, name: 'USATT', is_default: false },
] as const

const DEFAULT_MOCK_LEAGUE = MOCK_LEAGUES[0]

/** A player's rating **on one ladder**. There is no such thing as their rating
 * "in general" (ADR-0915) — so the second league runs a fixed offset below the
 * default one, and switching leagues visibly rebinds the hero, the rating panel
 * and the confidence card rather than redrawing the same numbers. An unrated
 * player is unrated everywhere. */
function leagueRating(
  base: number | null | undefined,
  leagueId: string,
): number | null {
  if (base == null) return null
  return leagueId === DEFAULT_MOCK_LEAGUE.id ? base : base - 45
}

/** The Leagues card's rows: every league this player belongs to, each carrying
 * THEIR rating on it. The list is deliberately NOT scoped to the requested
 * league — it is the same on every request for this player; which row is
 * *selected* is the client's business (ADR-0915). */
function playerLeagues(base: number | null | undefined) {
  return MOCK_LEAGUES.map((league) => ({
    id: league.id,
    name: league.name,
    is_default: league.is_default,
    rating: leagueRating(base, league.id),
  }))
}

/**
 * The profile's **viewer-aware** head-to-head block (ADR-0915) — the one part of
 * the bundle whose answer depends on *who is asking*. Mirrors `_load_head_to_head`
 * in `api/app/head_to_head.py`:
 *
 * - asked for **yourself**, there is no `versus_viewer` at all. You cannot have a
 *   record against yourself, and the profile must not offer to start a match with
 *   you — so the API omits the block and the card degrades to your frequent
 *   opponents. The mock viewer is always `MOCK_CURRENT_PLAYER_ID`, so opening
 *   `/players/u-me` in `npm run dev` shows exactly that;
 * - asked for **anyone else**, it is present — *even when the pair have never
 *   met*, which is the common case in production (a guest session is minted for
 *   anyone who lands on a profile link, and a guest has played nobody). Zero
 *   meetings is a first-class value here, never a `null`: the card's
 *   "You haven't played X yet" + Start-a-match CTA is rendered off it, and needs
 *   the `opponent` to prefill the match with.
 *
 * One roster player (`silva.r`) is deliberately seeded as never-met so that empty
 * state — the app's best conversion moment — is reachable under `npm run dev`
 * without clearing a cookie.
 *
 * `meetings` is `wins + losses`, derived rather than stored (the API refuses to
 * carry a field and its own derivation), so it is derived here too.
 */
function playerHeadToHead(p: {
  id: string
  username: string
}): components['schemas']['PlayerHeadToHead'] {
  const roster = mockPlayerRoster()
  const seed = djb2(p.username)
  const record = (
    opponent: { id: string; username: string },
    salt: number,
  ) => {
    const wins = (djb2(opponent.username) + salt) % 7
    const losses = (seed + salt) % 5
    return {
      opponent: { id: opponent.id, username: opponent.username },
      wins,
      losses,
      meetings: wins + losses,
    }
  }

  // Asked for YOURSELF there is no `versus_viewer` at all — you cannot have a
  // record against yourself. This check comes FIRST, and deliberately: a viewer
  // who had never played would otherwise fall into the never-met branch below and
  // be handed a zeroed record against *themselves*, with a "Start a match" CTA
  // pointing at their own profile. Rita is rated today, so that is latent — but it
  // is exactly the state you land in the moment the mock "you" is made unrated.
  const frequentOpponents = () =>
    roster
      .filter((other) => other.id !== p.id && hasPlayed(other))
      .map((other) => record(other, 0))
      .sort((a, b) => b.meetings - a.meetings)
      .slice(0, 3)
  if (p.id === MOCK_CURRENT_PLAYER_ID) {
    return {
      versus_viewer: null,
      frequent_opponents: hasPlayed(p) ? frequentOpponents() : [],
    }
  }

  // A meeting is a DECIDED match, so a player who has never played has met
  // nobody — and nobody has met them. The block is still present (never `null`):
  // the card renders its "You haven't played X yet" invitation and the
  // Start-a-match CTA off it, which is the whole point of a profile you reached
  // by link. Their `versus_viewer` is a zeroed, never-met record, and their
  // frequent-opponents list is empty.
  if (!hasPlayed(p)) {
    return {
      versus_viewer: {
        opponent: { id: p.id, username: p.username },
        wins: 0,
        losses: 0,
        meetings: 0,
        last_meeting: null,
      },
      frequent_opponents: [],
    }
  }

  // The profiled player's most-met opponents — top three, as the API caps it.
  // Never-played players are excluded for the same reason: you cannot have met
  // someone who has played nobody, so they must not surface as anyone's frequent
  // opponent.
  const frequent = frequentOpponents()

  // The viewer's own record AGAINST this player — read from the viewer's side, so
  // `opponent` is the player whose profile this is.
  const neverMet = p.username === 'silva.r'
  const wins = neverMet ? 0 : 1 + (seed % 4)
  const losses = neverMet ? 0 : seed % 5
  return {
    versus_viewer: {
      opponent: { id: p.id, username: p.username },
      wins,
      losses,
      meetings: wins + losses,
      last_meeting: neverMet
        ? null
        : new Date(Date.UTC(2025, seed % 12, 1 + (seed % 27))).toISOString(),
    },
    frequent_opponents: frequent,
  }
}

/** How many days each range's calendar window spans (mirrors `window_start` in
 * `api/app/ratings/history.py`). */
const RANGE_DAYS: Record<RatingRange, number> = {
  '30d': 30,
  '90d': 90,
  '1y': 365,
}

/** A range the caller may have sent as anything at all. Anything but the three
 * the API accepts degrades to the default, as FastAPI's `Literal` would 422 it and
 * the client's search schema never puts one on the wire. */
function parseRange(raw: string | null): RatingRange {
  return RATING_RANGES.find((range) => range === raw) ?? DEFAULT_RATING_RANGE
}

const isoDaysAgo = (days: number): string =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

/**
 * The player's rating over one CALENDAR window — the profile's chart (ADR-0915).
 * Mirrors `player_rating_history` in `api/app/ratings/history.py`, and holds the
 * three things the real endpoint's shape turns on:
 *
 * - the **anchor is dated OUTSIDE the window**: it is the player's rating *as of
 *   the window start*, carried in from their last match before it. It is what
 *   makes "up +127 over 90 days" true, so a mock that started the line at the
 *   first in-window point would let a chart that ignores the anchor look right;
 * - `change` is measured **from that anchor** to the latest point;
 * - an **unrated** player gets a wholly empty window — no anchor, no points, no
 *   change. Not a zeroed one: they have no rating timeline at all, and the profile
 *   draws them no chart.
 *
 * The window is relative to *now* and deterministic per (player, range), so
 * flipping the range tab in `npm run dev` visibly redraws the line rather than
 * re-serving the same one.
 */
function playerRatingHistory(
  summary: PlayerSummary,
  range: RatingRange,
): RatingHistoryWindow {
  const rating = summary.rating
  if (rating == null) {
    return { anchor: null, points: [], peak: null, change: null }
  }
  const days = RANGE_DAYS[range]
  const seed = djb2(`${summary.username}:${range}`)
  const count = 5 + (seed % 6)
  // The window's net movement, and so the anchor it must have started from.
  const net = 20 + (seed % 90)
  const anchorRating = rating - net
  const anchor = {
    at: isoDaysAgo(days + 4 + (seed % 25)),
    rating: anchorRating,
    match_id: mockUuid(`match:anchor:${summary.id}`),
  }
  const points = Array.from({ length: count }, (_, i) => {
    const progress = (i + 1) / count
    const wobble = (((seed >> i) % 21) - 10) * (i === count - 1 ? 0 : 1)
    return {
      // The last point is the player's CURRENT rating: the line's right-hand end
      // and the hero's big number are the same fact.
      rating:
        i === count - 1
          ? rating
          : Math.round(anchorRating + net * progress + wobble),
      at: isoDaysAgo(Math.max(1, days * (1 - progress))),
      match_id: mockUuid(`match:rating-point:${summary.id}:${i}`),
    }
  })
  const peak = points.reduce((best, point) =>
    point.rating > best.rating ? point : best,
  )
  return { anchor, points, peak, change: rating - anchorRating }
}

/** PlayerDetail = PlayerSummary + the hero's standing (member-since, peak,
 * rank-of-ladder, percentile, rating delta) + the cross-league career block +
 * the player's leagues + the viewer-aware head-to-head + the chart's window + the
 * six most recent matches + the all-inclusive `match_total` behind the
 * "View all N matches" link.
 *
 * `leagueId` is the ladder the **rating half** of the bundle is about, defaulting
 * to the default league when the caller names none. Career ignores it, and so
 * do the head-to-head and the match list.
 *
 * `range` is the chart's calendar window, embedded so the profile's first paint
 * costs ONE request — the client seeds the chart's own cache from it and calls
 * `/rating-history` only when the user flips range (ADR-0915). */
function playerDetail(
  p: {
    id: string
    username: string
    rating?: number | null
  },
  leagueId: string = DEFAULT_MOCK_LEAGUE.id,
  range: RatingRange = DEFAULT_RATING_RANGE,
): PlayerDetail {
  // The rating half of the bundle is scoped to the requested league; everything
  // below reads off this league-scoped summary.
  const summary = summarizePlayer({
    ...p,
    rating: leagueRating(p.rating, leagueId),
  })
  const rows = projectPlayerMatches({ id: p.id, username: p.username })
  const seed = djb2(p.username)
  return {
    ...summary,
    // A stable join date: month + year is all the hero shows.
    member_since: new Date(
      Date.UTC(2023 + (seed % 3), seed % 12, 1 + (seed % 27)),
    ).toISOString(),
    ...playerStanding(summary, rows),
    // Cross-league, so it reads off the player's *unscoped* record — ask for this
    // player in either league and the career block comes back identical.
    career: playerCareer(summarizePlayer(p)),
    leagues: playerLeagues(p.rating),
    // Viewer-aware, and deliberately NOT league-scoped: a meeting is a decided
    // match in any league (ADR-0915).
    head_to_head: playerHeadToHead(p),
    // League-scoped like the rest of the rating half — it reads off the SAME
    // league-scoped summary, so the line ends where the hero's rating does.
    rating_history: playerRatingHistory(summary, range),
    match_total: rows.length,
    matches: {
      items: rows.slice(0, PROFILE_RECENT_MATCHES),
      page: 1,
      page_size: PROFILE_RECENT_MATCHES,
      total: rows.length,
    },
  }
}

/** Backs the per-player-matches handler — projects the player's matches and
 * slices to the requested page. */
function paginatedMatches(
  player: { id: string; username: string },
  request: Request,
) {
  const url = new URL(request.url)
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'))
  const pageSize = Math.max(
    1,
    Number(url.searchParams.get('page_size') ?? '25'),
  )
  const rows = projectPlayerMatches(player)
  const start = (page - 1) * pageSize
  return HttpResponse.json({
    items: rows.slice(start, start + pageSize),
    page,
    page_size: pageSize,
    total: rows.length,
  })
}

function projectPlayerMatches(player: {
  id: string
  username: string
}): PlayerMatchRow[] {
  // Real-match flow for the current user; for opponents, surface the same
  // matches they appeared in (flipped to their perspective).
  const isMe = player.id === MOCK_CURRENT_PLAYER_ID
  const myMatches = isMe
    ? mockMatches
    : mockMatches.filter((m) => m.opponent?.id === player.id)

  const projected = myMatches
    .slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((m) => {
      // The "perspective" player is on side 1 if they're the current user,
      // side 2 otherwise (since mocks always put rita on side 1).
      const onSide1 = isMe
      const opponentUsername = onSide1
        ? (m.opponent?.username ?? null)
        : mockSession.data.user.username
      const opponentId = onSide1
        ? (m.opponent?.id ?? null)
        : MOCK_CURRENT_PLAYER_ID
      const games = m.games
        .filter((g): g is typeof g & { score: NonNullable<typeof g.score> } =>
          g.score !== null,
        )
        .map((g) => ({
          mine: onSide1 ? g.score.side_1_points : g.score.side_2_points,
          theirs: onSide1 ? g.score.side_2_points : g.score.side_1_points,
        }))
      const target = Math.ceil(m.best_of / 2)
      let gamesWonByMe = 0
      let gamesWonByThem = 0
      for (const g of games) {
        if (g.mine > g.theirs) gamesWonByMe += 1
        else if (g.theirs > g.mine) gamesWonByThem += 1
      }
      let result: 'W' | 'L' | null = null
      if (m.status === 'completed') {
        if (gamesWonByMe >= target) result = 'W'
        else if (gamesWonByThem >= target) result = 'L'
      }
      return { m, games, result, opponentId, opponentUsername }
    })

  // The player's **first** decided match — the rows are newest-first, so it is
  // the last of them. That match ESTABLISHED their rating; it did not move one
  // (#952). Modelling it is the whole reason this mock can catch the bug: a mock
  // that only ever emits moves is a mock that cannot.
  const firstDecidedId =
    [...projected].reverse().find((p) => p.result !== null)?.m.id ?? null

  return projected.map(({ m, games, result, opponentId, opponentUsername }): PlayerMatchRow => {
    // The rating this match moved, for the Recent-matches card's Δ column.
    // `null` — never a zero-delta object — for anything undecided (live, up
    // next, awaiting, voided) or unrated, so the dev view exercises the em-dash
    // path the way the real API does.
    const ratingBefore = 1600 + (djb2(m.id) % 120)
    const moved = 6 + (djb2(m.id) % 13)
    const delta = result === 'W' ? moved : -moved
    const after = ratingBefore + delta
    const rating_change =
      result === null
        ? null
        : m.id === firstDecidedId
          ? // Their first: `before` and `delta` are both null. The Δ column reads
            // `—`, and the match page reads `Unrated → {after}`.
            buildEstablishedRatingChange({ after })
          : buildRatingChange({ before: ratingBefore, after })
    return {
      id: m.id,
      status: m.status,
      created_at: m.created_at,
      opponent: { id: opponentId, username: opponentUsername },
      games,
      result,
      awaiting_acceptance: false,
      rating_change,
    }
  })
}

async function readJson(request: Request): Promise<unknown> {
  try {
    const text = await request.clone().text()
    if (!text) return undefined
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function rbacHandlerFor(rbacState: RbacState) {
  return async ({ request }: { request: Request }) => {
    const url = new URL(request.url)
    const path = url.pathname.replace(/^\/api/, '')
    const body = await readJson(request)
    const result = dispatchRbac(rbacState, request.method, path, body)
    if (!result) {
      return HttpResponse.json({ detail: `unmocked ${request.method} ${path}` }, { status: 404 })
    }
    if (result.status === 204) return new HttpResponse(null, { status: 204 })
    return HttpResponse.json(result.body as Parameters<typeof HttpResponse.json>[0], {
      status: result.status,
    })
  }
}

/**
 * The RBAC routes bound to a caller-owned `RbacState`. The default handlers use
 * the shared `DEMO_SEED` state; a test that needs a deterministic universe
 * (e.g. "exactly one default role and one plain one") builds its own state and
 * `server.use(...)`es these over the top.
 */
export function rbacHandlersFor(rbacState: RbacState) {
  const handler = rbacHandlerFor(rbacState)
  return RBAC_PATHS.flatMap((path) => [
    http.get(path, handler),
    http.post(path, handler),
    http.patch(path, handler),
    http.put(path, handler),
    http.delete(path, handler),
  ])
}

const RBAC_PATHS = [
  '*/v1/permissions',
  '*/v1/permissions/:id',
  '*/v1/roles',
  '*/v1/roles/:id',
  '*/v1/users',
  '*/v1/users/:id',
  '*/v1/users/:id/roles',
]

type MatchCreateBody = components['schemas']['MatchCreate']
type MatchScoreBody = components['schemas']['MatchGameScoreWrite']
type MatchScoreUpdateBody = components['schemas']['MatchGameScoreUpdate']
type MatchResultsBody = components['schemas']['MatchResultsWrite']

function detail(message: string, status = 422) {
  return HttpResponse.json({ detail: message }, { status })
}

/**
 * Why a **draw configuration** is refused (ADR 20260727) — the mock's own sentences for
 * the server's own rules.
 *
 * The RULES are mirrored exactly, and must be: a mock more permissive than the server is
 * how a client ships a body the API 422s (it already happened on this arc). The WORDS are
 * not. The server renders these three through pydantic — `Field required`,
 * `Input should be greater than or equal to 1`, `Extra inputs are not permitted`, joined
 * `loc: msg` — and reproducing a library's prose here pins nothing: no test, on either
 * side, holds pydantic to those strings, so a minor bump would silently desynchronise
 * `npm run dev` and vitest from production with everything still green.
 *
 * So these are authored, in the app's voice, and each names `qualifiers_per_group` — the
 * field the director has to fix, which is the part that IS load-bearing. Tests pin the
 * rule that fired by referring to the constant, never by retyping a sentence.
 *
 * `countUnpaired` is the exception, verbatim on purpose: that one is a **human-written**
 * sentence in `_parse_draw_settings` (`api/app/schemas/tournament.py`), not a library's.
 */
export const DRAW_SETTINGS_REFUSALS = {
  /** `rr-then-ko` requires a count, and has no default to fall back on. */
  countRequired:
    'An “rr-then-ko” event needs a qualifiers_per_group: how many of each group’s ' +
    'finishers advance into the knockout stage. There is no default — name a count.',
  /** `K ≥ 1`, and a whole number of players. */
  countTooSmall:
    'qualifiers_per_group must be a whole number of 1 or more: a knockout stage ' +
    'nobody qualifies for is not a stage.',
  /** `K ≤ 1000`, the same ceiling the server enforces. */
  countTooLarge:
    'qualifiers_per_group must be 1,000 or fewer: no group advances more players ' +
    'than that into the knockout stage.',
  /** The two count-less arms declare no such field, so the key is refused outright —
   * never silently dropped on the way to a column whose `CHECK` says `NULL`. */
  countForbidden: (drawType: string) =>
    `A “${drawType}” draw has no knockout stage to qualify for, so it takes no ` +
    'qualifiers_per_group. Remove the count.',
  /** A count arriving with no `draw_type` beside it — the server's own words. */
  countUnpaired:
    'qualifiers_per_group is part of an event’s draw configuration and is patched ' +
    'with it: send draw_type alongside it.',
} as const

/** Mirror the server's event-body constraints (ADR-0935) so an invalid event is
 * a 422 the editor surfaces inline, not a value the store silently accepts:
 *   • name — required, at most 255 chars.
 *   • the draw configuration — `(draw_type, qualifiers_per_group)` as a pair (ADR
 *     20260727): required and ≥ 1 for `rr-then-ko`, refused outright on the other two.
 *   • max_players — when present, a positive integer (`null` = no cap is fine).
 *   • entry_fee — when present, non-negative.
 * Returns a 422 response for the first violation, or `null` when the body is OK.
 * Applies to both create and PATCH (a PATCH omits fields, so each check is
 * skipped when its field is absent — except `name`, which create requires). */
function validateEventBody(
  body:
    | components['schemas']['TournamentEventCreate']
    | components['schemas']['TournamentEventUpdate']
    | undefined,
): Response | null {
  if (!body) return detail('Event body is required.', 422)
  if ('name' in body && body.name !== undefined) {
    const name = body.name?.trim() ?? ''
    if (!name) return detail('Name is required.', 422)
    if (name.length > 255) {
      return detail('Name must be 255 characters or fewer.', 422)
    }
  }
  // The **draw configuration**, judged as the pair it is (ADR 20260727). On the server
  // `(draw_type, qualifiers_per_group)` is flat on the wire and a discriminated union in
  // the interior: the `rr-then-ko` arm REQUIRES a count with no default, and the other
  // two arms are `extra="forbid"` and declare no such field — so a count sent with either
  // of them is a 422, not a value quietly dropped on the way to a column whose `CHECK`
  // says `NULL`.
  //
  // Mirrored here because a mock more permissive than the server is a trap: a client that
  // sent `qualifiers_per_group: null` on a round-robin event, or a bare `rr-then-ko` with
  // no count, would look perfectly healthy in `npm run dev` and in vitest, and 422 in
  // production. (The store below then keeps whatever survives this — see `createEvent`.)
  // The rules are the server's; the sentences are ours — see `DRAW_SETTINGS_REFUSALS`.
  if (body.draw_type !== undefined && body.draw_type !== null) {
    if (body.draw_type === 'rr-then-ko') {
      if (
        body.qualifiers_per_group === undefined ||
        body.qualifiers_per_group === null
      ) {
        return detail(DRAW_SETTINGS_REFUSALS.countRequired, 422)
      }
      if (
        !Number.isInteger(body.qualifiers_per_group) ||
        body.qualifiers_per_group < 1
      ) {
        return detail(DRAW_SETTINGS_REFUSALS.countTooSmall, 422)
      }
      if (body.qualifiers_per_group > 1000) {
        return detail(DRAW_SETTINGS_REFUSALS.countTooLarge, 422)
      }
    } else if (
      body.qualifiers_per_group !== undefined &&
      body.qualifiers_per_group !== null
    ) {
      return detail(DRAW_SETTINGS_REFUSALS.countForbidden(body.draw_type), 422)
    }
  } else if (
    body.qualifiers_per_group !== undefined &&
    body.qualifiers_per_group !== null
  ) {
    // A count with no draw type beside it: judging it would mean reading the event's
    // STORED draw type, two layers past the boundary. The server refuses it there
    // (`_parse_draw_settings`) and so does this.
    return detail(DRAW_SETTINGS_REFUSALS.countUnpaired, 422)
  }
  if (body.max_players !== undefined && body.max_players !== null) {
    if (!Number.isInteger(body.max_players) || body.max_players <= 0) {
      return detail('Player limit must be a positive whole number.', 422)
    }
  }
  if (body.entry_fee !== undefined && body.entry_fee !== null) {
    if (body.entry_fee < 0) {
      return detail('Entry fee can’t be negative.', 422)
    }
  }
  // A reservation id IDENTIFIES a reservation, and a fixture names the GROUP it was
  // dealt into (ADR-0786; a group is minted 1:1 with a reservation, ticket #1369). Two
  // ENTRIES citing one id is a payload the interior cannot hold: the write is an
  // id-keyed diff (`applyEventReservations`), so both entries resolve onto the one
  // stored reservation and the payload is accepted as a single-reservation event rather
  // than refused as the two-reservation one it claims to be (`_reservation_ids_are_unique`,
  // `api/app/schemas/tournament.py`).
  //
  // It lives HERE, at the mock's boundary rather than in the store's freeze, for the two
  // reasons the server's validator does:
  //  • it is a 422 in *every* state the event could be in — an event with no draw at all
  //    still cannot cite one reservation twice;
  //  • and it is the PATCH path's rule, because the group-set freeze compares SETS:
  //    `[A, A, B]` against a cut event holding `{A, B}` is the same set, so the freeze
  //    waves it through and the next cut dies. The guard that protects the draw was
  //    admitting the payload that poisons it.
  //
  // **Entries with no `id` are ignored**: those are additions, and any number of
  // reservations may be added at once. The rule has no create-path twin and needs none —
  // `ReservationWrite` has no `id` at all (ADR 20260801), so "the patch path is the hole"
  // is not a hole a create can have here.
  if (body.reservations != null) {
    const seen = new Set<string>()
    const duplicated = body.reservations
      // `'id' in reservation` is the narrowing, not a cast: the create shape declares no
      // such key, so this is also where a `ReservationWrite[]` body drops out of the
      // rule entirely.
      .map((reservation) => ('id' in reservation ? reservation.id : null))
      .filter((id): id is string => id != null)
      .filter((id) => (seen.has(id) ? true : (seen.add(id), false)))
    if (duplicated.length > 0) {
      const ids = [...new Set(duplicated)]
      return detail(
        `A reservation id identifies one reservation: ${namedList(ids)} ` +
          `${ids.length === 1 ? 'is' : 'are'} cited by more than one entry of this ` +
          "event's reservations. Cite each reservation you are keeping exactly once, " +
          'and omit the id of a reservation you are adding.',
        422,
      )
    }
  }
  return null
}

function enforceScorable(seed: SeedMatch): Response | null {
  if (
    seed.status === 'completed' ||
    seed.status === 'voided'
  ) {
    return detail('This match is no longer scorable.', 409)
  }
  // The first posted result freezes the scratchpad — scores are immutable
  // once a proposal exists (mirrors the server's `_enforce_scorable`).
  if (seed.results.length > 0) {
    return detail('This match has a posted result; scores are frozen.', 409)
  }
  return null
}

function notNull<T>(value: T | null): value is T {
  return value !== null
}

/** Parse the list's near-me triple off the query string. The API's `lat`/`lng`/
 * `radius_miles` are ALL-OR-NOTHING (they describe one location filter, not three
 * independent knobs), so a partial triple is a 422 there and here. Returns `{}` when none
 * are present (the default list), a `filter` when all three are, or an `error` string when
 * some — but not all — are. A non-numeric value is treated as present-but-invalid, so it
 * cannot silently drop out and turn a partial triple into a valid pair. */
function parseNearMe(params: URLSearchParams):
  | { filter?: NearMeFilter; error?: undefined }
  | { error: string; filter?: undefined } {
  const raw = [
    params.get('lat'),
    params.get('lng'),
    params.get('radius_miles'),
  ]
  const present = raw.filter(notNull)
  if (present.length === 0) return {}
  if (present.length < 3 || present.some((v) => !Number.isFinite(Number(v)))) {
    return {
      error:
        'lat, lng and radius_miles must be sent together as valid numbers — a location ' +
        'filter is all-or-nothing.',
    }
  }
  const [lat, lng, radiusMiles] = raw.map(Number)
  return { filter: { lat, lng, radiusMiles } }
}

export const handlers = [
  http.get('*/v1/health', async () => {
    await delay(400)
    return HttpResponse.json(mockHealthy)
  }),
  http.get('*/v1/session', async () => {
    await delay(600)
    return HttpResponse.json(mockSession)
  }),
  http.delete('*/v1/session', async () => {
    await delay(150)
    return new HttpResponse(null, { status: 204 })
  }),
  // ----- /v1/settings/agent-access (the Claude access page's BFF) ---------
  // The dev world is `ready`: an email on file, permission granted, nothing
  // connected. To walk the page's other states under `npm run dev`, change
  // `MOCK_AGENT_ACCESS` above — `connector: null` gives the "couldn't load"
  // row, and the other four `state` values give their own status rows.
  // Tests override this per-case with `mockAgentAccessEndpoint`.
  http.get('*/v1/settings/agent-access', async () => {
    await delay(200)
    return HttpResponse.json(agentAccessNow)
  }),
  // Clearing the player's own revocation. Returns the page's whole new state,
  // as the real endpoint does, so the client needs no follow-up read — and
  // records it, so a later GET *in the same page session* agrees with what the
  // button just claimed. (A hard reload re-evaluates this module and returns to
  // the seed, which is what you want when walking the state by hand.)
  //
  // Re-allow lands on `ready`, mirroring the server: disconnect cleared the
  // binding, so the setup panel — the only surface carrying the connector URL
  // and client id — is reachable again.
  //
  // The recording is module state shared by every later GET in the same module
  // instance, so a test that reaches this default without overriding it can
  // poison the ones after it. Today every test overrides both handlers for its
  // own case; if you add one that does not, override the endpoint rather than
  // relying on the default.
  http.post('*/v1/settings/agent-access/allow', async () => {
    await delay(300)
    agentAccessNow = { ...agentAccessNow, state: 'ready' }
    return HttpResponse.json(agentAccessNow)
  }),
  // The other half of that round trip: switching agent access off. Recorded the
  // same way, so seeding `MOCK_AGENT_ACCESS` with `state: 'connected'` lets the
  // dev world walk connected → disconnect → revoked → allow → ready without a
  // backend. `connected_on` goes with it: nothing is linked any more, and a
  // "connected on 12 May" left lying in the payload would resurface the moment
  // the account reconnects.
  http.post('*/v1/settings/agent-access/disconnect', async () => {
    await delay(300)
    agentAccessNow = { ...agentAccessNow, state: 'revoked', connected_on: null }
    return HttpResponse.json(agentAccessNow)
  }),
  // ----- /v1/stream (realtime hints) -------------------------------------
  // A PARKED stream: the reconnect directive and then silence, held open for
  // ever (see `./realtime-stream`). Every authenticated surface opens one, so
  // without this handler any test that renders `_app` — and dev mode itself —
  // would fall through: vitest errors on the unhandled request, and the dev
  // browser would get `index.html` back from vite and reconnect-loop over it.
  //
  // Written by hand rather than with MSW's `sse()` helper on purpose: `sse()`
  // invariants on a global `EventSource` that neither jsdom nor Node 26
  // exposes, and it buys nothing here — the frame is one literal string.
  http.get('*/v1/stream', () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(PARKED_STREAM_BODY))
        // Never closed: a real stream stays open, and closing would send the
        // client into its reconnect path for no reason.
      },
    })
    return new HttpResponse(body, {
      headers: { 'Content-Type': SSE_CONTENT_TYPE, 'Cache-Control': 'no-cache' },
    })
  }),
  // ----- /v1/players list + per-player profile + per-player matches ------
  // BFF endpoints — each returns exactly what its consumer page needs. The
  // dev-only handlers below synthesize deterministic W-L + form so the
  // /players list and profile hero render plausible numbers without a
  // backend.
  http.get('*/v1/players', async ({ request }) => {
    await delay(250)
    const url = new URL(request.url)
    const q = url.searchParams.get('q')?.trim().toLowerCase() ?? ''
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'))
    const pageSize = Math.max(
      1,
      Number(url.searchParams.get('page_size') ?? '25'),
    )
    const roster = mockPlayerRoster()
    const filtered = q
      ? roster.filter((p) => p.username.toLowerCase().includes(q))
      : roster
    // Mirror the backend's "rating desc, NULLs last" sort. Coerce
    // undefined → null so the comparator treats both the same.
    const sorted = filtered.slice().sort((a, b) => {
      const ra = a.rating ?? null
      const rb = b.rating ?? null
      if (ra === null && rb === null) return a.username.localeCompare(b.username)
      if (ra === null) return 1
      if (rb === null) return -1
      return rb - ra
    })
    const start = (page - 1) * pageSize
    const slice = sorted.slice(start, start + pageSize)
    return HttpResponse.json({
      items: slice.map(summarizePlayer),
      page,
      page_size: pageSize,
      total: filtered.length,
    })
  }),
  // Literal-path handlers must be registered before `:playerId` — MSW
  // matches in declaration order, so otherwise `/v1/players/recent` and
  // `/v1/players/search` would be caught as `playerId='recent'/'search'`
  // and 404 in dev mode (the new-match opponent picker breaks).
  http.get('*/v1/players/recent', async () => {
    await delay(300)
    return HttpResponse.json(mockRecentOpponents)
  }),
  http.get('*/v1/players/search', async ({ request }) => {
    await delay(200)
    const q = new URL(request.url).searchParams.get('q')?.trim().toLowerCase()
    if (!q) return HttpResponse.json([])
    return HttpResponse.json(
      mockPlayers
        .filter((p) => p.username.toLowerCase().includes(q))
        .slice(0, 10),
    )
  }),
  http.get('*/v1/players/:playerId', async ({ params, request }) => {
    await delay(200)
    const playerId = String(params.playerId)
    const player = mockPlayerRoster().find((p) => p.id === playerId)
    if (!player) {
      return HttpResponse.json(
        { detail: 'Player not found.' },
        { status: 404 },
      )
    }
    // `?league_id=` selects the ladder the rating half of the bundle is about
    // (ADR-0915). An unknown one is a 404 here exactly as it is in the API
    // (`resolve_league`) — the client never sends a malformed one, because the
    // route's search schema catches it before it reaches the wire.
    const url = new URL(request.url)
    const leagueId = url.searchParams.get('league_id')
    if (leagueId && !MOCK_LEAGUES.some((league) => league.id === leagueId)) {
      return HttpResponse.json(
        { detail: 'League not found.' },
        { status: 404 },
      )
    }
    // `?range=` names the chart's window, embedded in the bundle so the profile's
    // first paint is one request. Answering the DEFAULT window whatever was asked
    // for would break exactly that: the client seeds the chart's cache from this
    // block for the range it asked for, so a mock that ignored the param would
    // hand a 90-day window to a 30-day chart.
    return HttpResponse.json(
      playerDetail(
        player,
        leagueId ?? undefined,
        parseRange(url.searchParams.get('range')),
      ),
    )
  }),
  // The chart's own endpoint — the one narrow request a range flip makes. Same
  // shape as the bundle's embedded `rating_history` block, on purpose: the client
  // seeds this cache from that one.
  http.get('*/v1/players/:playerId/rating-history', async ({ params, request }) => {
    await delay(200)
    const playerId = String(params.playerId)
    const found = mockPlayerRoster().find((p) => p.id === playerId)
    if (!found) {
      return HttpResponse.json({ detail: 'Player not found.' }, { status: 404 })
    }
    const url = new URL(request.url)
    const leagueId = url.searchParams.get('league_id')
    if (leagueId && !MOCK_LEAGUES.some((league) => league.id === leagueId)) {
      return HttpResponse.json({ detail: 'League not found.' }, { status: 404 })
    }
    // A rating is a fact about ONE ladder (ADR-0915), so the window is read off
    // the league-scoped summary — the same one the bundle's block comes from.
    const summary = summarizePlayer({
      ...found,
      rating: leagueRating(found.rating, leagueId ?? DEFAULT_MOCK_LEAGUE.id),
    })
    return HttpResponse.json(
      playerRatingHistory(summary, parseRange(url.searchParams.get('range'))),
    )
  }),
  http.get('*/v1/players/:playerId/matches', async ({ params, request }) => {
    await delay(300)
    const playerId = String(params.playerId)
    const player = mockPlayerRoster().find((p) => p.id === playerId)
    if (!player) {
      return HttpResponse.json(
        { detail: 'Player not found.' },
        { status: 404 },
      )
    }
    return paginatedMatches(player, request)
  }),
  http.patch('*/v1/me', async ({ request }) => {
    const body = (await readJson(request)) as { username?: string } | undefined
    const next = body?.username?.trim() ?? ''
    if (!next) return detail('Username is required.')
    mockSession.data.user = { ...mockSession.data.user, username: next }
    return HttpResponse.json(mockSession)
  }),
  http.post('*/v1/me/email', async ({ request }) => {
    const body =
      ((await readJson(request)) as {
        email?: string
        captcha_token?: string
        fmm_hp_token?: string
      } | undefined) ?? {}
    // Honeypot win condition: behave like success without persisting.
    if (body.fmm_hp_token?.trim()) {
      return HttpResponse.json(mockSession, { status: 202 })
    }
    if (!body.captcha_token) return detail('Captcha required.', 400)
    if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email))
      return detail('Invalid email.', 422)
    const next = body.email.toLowerCase()
    if (
      mockSession.data.user.email === next &&
      mockSession.data.user.confirmed_at
    ) {
      return HttpResponse.json(mockSession, { status: 202 })
    }
    mockSession.data.user = {
      ...mockSession.data.user,
      pending_email: next,
    }
    return HttpResponse.json(mockSession, { status: 202 })
  }),
  http.post('*/v1/me/email/resend', async ({ request }) => {
    const body =
      ((await readJson(request)) as {
        captcha_token?: string
        fmm_hp_token?: string
      } | undefined) ?? {}
    if (body.fmm_hp_token?.trim())
      return HttpResponse.json(mockSession, { status: 202 })
    if (!mockSession.data.user.pending_email)
      return detail('No pending email change to resend.', 400)
    if (!body.captcha_token) return detail('Captcha required.', 400)
    return HttpResponse.json(mockSession, { status: 202 })
  }),
  http.post('*/v1/me/email/confirm', async ({ request }) => {
    const body =
      ((await readJson(request)) as { token?: string } | undefined) ?? {}
    if (!body.token) return detail('Missing token.', 400)
    if (!mockSession.data.user.pending_email)
      return detail('That confirmation link is invalid or expired.', 400)
    mockSession.data.user = {
      ...mockSession.data.user,
      email: mockSession.data.user.pending_email,
      confirmed_at: new Date().toISOString(),
      pending_email: null,
    }
    return HttpResponse.json(mockSession)
  }),
  http.post('*/v1/login/request', async ({ request }) => {
    const body =
      ((await readJson(request)) as {
        email?: string
        captcha_token?: string
        fmm_hp_token?: string
      } | undefined) ?? {}
    if (body.fmm_hp_token?.trim())
      return HttpResponse.json({ email: body.email ?? '' }, { status: 202 })
    if (!body.captcha_token) return detail('Captcha required.', 400)
    if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email))
      return detail('Invalid email.', 422)
    // Always 202 — the mock matches the API's enumeration-safe shape.
    return HttpResponse.json(
      { email: body.email.toLowerCase() },
      { status: 202 },
    )
  }),
  http.post('*/v1/login/consume', async ({ request }) => {
    const body =
      ((await readJson(request)) as { token?: string } | undefined) ?? {}
    if (!body.token) return detail('Missing token.', 400)
    // The dev-mode magic token "expired" is a deliberate hook for letting
    // designers test the failure screen end-to-end without rewriting
    // handlers — anything else succeeds.
    if (body.token === 'expired')
      return detail('That sign-in link is invalid or expired.', 400)
    // Return a *fresh* confirmed session rather than mutating the shared
    // `mockSession` singleton in place. The old in-place write leaked
    // `email`/`confirmed_at` into whichever test ran next in file order, so a
    // reorder or single-test run could flake (#229).
    return HttpResponse.json({
      ...mockSession,
      data: {
        ...mockSession.data,
        user: {
          ...mockSession.data.user,
          email: mockSession.data.user.email ?? 'rita@example.com',
          confirmed_at:
            mockSession.data.user.confirmed_at ?? new Date().toISOString(),
        },
      },
    })
  }),
  // Default: not a merge, so the verify/confirm screens finalize straight away.
  // Tests that exercise the gate override this with `server.use(...)`.
  http.post('*/v1/merge/preview', () =>
    HttpResponse.json({
      is_merge: false,
      owner_username: null,
      guest_username: null,
      guest_matches_count: 0,
      adopts_guest_username: false,
    }),
  ),
  // ----- matches ---------------------------------------------------------
  http.post('*/v1/matches', async ({ request }) => {
    await delay(400)
    const body = (await readJson(request)) as MatchCreateBody
    let opponent: { id: string; username: string } | null = null
    if (body.opponent_user_id) {
      const found = mockPlayers.find((p) => p.id === body.opponent_user_id)
      opponent = found ? { id: found.id, username: found.username } : null
    }
    const seed = newMatchSeed({
      bestOf: body.best_of,
      rated: body.rated,
      opponent,
    })
    mockMatches.unshift(seed)
    return HttpResponse.json(projectMatchDetails(seed), { status: 201 })
  }),

  http.get('*/v1/matches.csv', async ({ request }) => {
    const url = new URL(request.url)
    const statusFilter = url.searchParams.get('status') ?? null
    const q = url.searchParams.get('q')?.trim().toLowerCase() ?? ''
    let scoped = mockMatches.slice()
    if (q) {
      scoped = scoped.filter((m) => matchHasPlayerLike(m, q))
    }
    const filtered = statusFilter
      ? scoped.filter((m) => matchesListFilter(m, statusFilter))
      : scoped

    const esc = (v: string) =>
      /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
    const lines = [
      'Match ID,Created,Status,League,Side 1,Side 2,Score,Best of',
    ]
    for (const row of filtered.map(projectListRow)) {
      const sides = [...row.sides].sort((a, b) => a.side_number - b.side_number)
      const names = (s: (typeof sides)[number] | undefined) =>
        s ? s.players.map((p) => p.username).join(' & ') : ''
      const score =
        (row.status === 'in_progress' || row.status === 'completed') &&
        sides[0] &&
        sides[1]
          ? `${sides[0].games_won}-${sides[1].games_won}`
          : ''
      lines.push(
        [
          String(row.id),
          row.created_at,
          row.status_label,
          row.league.name,
          names(sides[0]),
          names(sides[1]),
          score,
          String(row.best_of),
        ]
          .map((c) => esc(String(c)))
          .join(','),
      )
    }
    return new HttpResponse(lines.join('\r\n'), {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="fortymm-matches.csv"',
      },
    })
  }),

  http.get('*/v1/matches', async ({ request }) => {
    await delay(250)
    const url = new URL(request.url)
    const statusFilter = url.searchParams.get('status') ?? null
    const attention = url.searchParams.get('attention') === 'true'
    const q = url.searchParams.get('q')?.trim().toLowerCase() ?? ''
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'))
    const pageSize = Math.max(
      1,
      Number(url.searchParams.get('page_size') ?? '25'),
    )

    let scoped = mockMatches.slice()
    if (q) {
      scoped = scoped.filter((m) => matchHasPlayerLike(m, q))
    }
    // The Attention badge reads this regardless of the active tab.
    const attentionSeeds = rankAttentionSeeds(scoped)
    // Attention is its own dimension: rank the open matches by urgency and
    // ignore the status filter. Otherwise apply the status filter — which splits
    // Live from awaiting-confirmation, mirroring the server (issue #381).
    const filtered = attention
      ? attentionSeeds
      : statusFilter
        ? scoped.filter((m) => matchesListFilter(m, statusFilter))
        : scoped

    const start = (page - 1) * pageSize
    const slice = filtered.slice(start, start + pageSize)
    return HttpResponse.json({
      items: slice.map(projectListRow),
      page,
      page_size: pageSize,
      total: filtered.length,
      status_counts: statusCountsOf(scoped),
      attention_count: attentionSeeds.length,
      awaiting_acceptance_count: awaitingCountOf(scoped),
    })
  }),

  http.get('*/v1/matches/:matchId', async ({ params }) => {
    await delay(200)
    const seed = findMatch(String(params.matchId))
    if (!seed) return detail('Match not found.', 404)
    return HttpResponse.json(projectMatchDetails(seed))
  }),

  // Per-game scratchpad endpoints: write/edit/clear a single game's score.
  // These never change match.status or side wins — finalization lives in
  // POST .../results below.

  http.post(
    '*/v1/matches/:matchId/games/:gameNumber/scores/new',
    async ({ params, request }) => {
      await delay(250)
      const seed = findMatch(String(params.matchId))
      if (!seed) return detail('Match not found.', 404)
      const gateError = enforceScorable(seed)
      if (gateError) return gateError
      const gameNumber = Number(params.gameNumber)
      if (!Number.isInteger(gameNumber) || gameNumber < 1) {
        return detail('Invalid game_number.', 422)
      }
      if (gameNumber > seed.best_of) {
        return detail(
          `This match is best of ${seed.best_of}; game ${gameNumber} can't exist.`,
          422,
        )
      }
      const body = (await readJson(request)) as MatchScoreBody
      const message = validateScore(body.side_1_points, body.side_2_points)
      if (message) return detail(message, 422)

      let game = seed.games.find((g) => g.game_number === gameNumber)
      if (!game) {
        game = {
          id: `g-${seed.id}-${gameNumber}`,
          game_number: gameNumber,
          score: null,
        }
        seed.games.push(game)
      } else if (game.score !== null) {
        // A concurrent create — same structured conflict body the update path
        // returns, carrying the committed score for the client to surface.
        return HttpResponse.json(
          {
            detail: {
              message:
                'This game was saved by someone else while you were editing. ' +
                'Review the saved score before saving again.',
              committed_score: {
                id: game.score.id,
                side_1_points: game.score.side_1_points,
                side_2_points: game.score.side_2_points,
                winner_side_number:
                  game.score.side_1_points > game.score.side_2_points ? 1 : 2,
                version: game.score.version ?? 1,
              },
            },
          },
          { status: 409 },
        )
      }
      game.score = {
        id: `s-${seed.id}-${gameNumber}-${Date.now().toString(36)}`,
        side_1_points: body.side_1_points,
        side_2_points: body.side_2_points,
        version: 1,
      }
      return HttpResponse.json(projectMatchDetails(seed), { status: 201 })
    },
  ),

  http.put(
    '*/v1/matches/:matchId/games/:gameNumber/scores',
    async ({ params, request }) => {
      await delay(250)
      const seed = findMatch(String(params.matchId))
      if (!seed) return detail('Match not found.', 404)
      const gateError = enforceScorable(seed)
      if (gateError) return gateError
      const gameNumber = Number(params.gameNumber)
      const game = seed.games.find((g) => g.game_number === gameNumber)
      if (!game || game.score === null) {
        return detail('Score not found.', 404)
      }
      const body = (await readJson(request)) as MatchScoreUpdateBody
      const message = validateScore(body.side_1_points, body.side_2_points)
      if (message) return detail(message, 422)
      // Optimistic concurrency: reject a stale write rather than overwrite a
      // score a concurrent participant has since saved. Mirrors the server's
      // 409-with-committed-score body.
      const currentVersion = game.score.version ?? 1
      if (body.expected_version !== currentVersion) {
        return HttpResponse.json(
          {
            detail: {
              message:
                'This game was saved by someone else while you were editing. ' +
                'Review the saved score before saving again.',
              committed_score: {
                id: game.score.id,
                side_1_points: game.score.side_1_points,
                side_2_points: game.score.side_2_points,
                winner_side_number:
                  game.score.side_1_points > game.score.side_2_points ? 1 : 2,
                version: currentVersion,
              },
            },
          },
          { status: 409 },
        )
      }
      game.score = {
        id: game.score.id,
        side_1_points: body.side_1_points,
        side_2_points: body.side_2_points,
        version: currentVersion + 1,
      }
      return HttpResponse.json(projectMatchDetails(seed))
    },
  ),

  http.delete(
    '*/v1/matches/:matchId/games/:gameNumber/scores',
    async ({ params }) => {
      await delay(250)
      const seed = findMatch(String(params.matchId))
      if (!seed) return detail('Match not found.', 404)
      const gateError = enforceScorable(seed)
      if (gateError) return gateError
      const gameNumber = Number(params.gameNumber)
      const game = seed.games.find((g) => g.game_number === gameNumber)
      if (!game || game.score === null) {
        return detail('Score not found.', 404)
      }
      game.score = null
      return HttpResponse.json(projectMatchDetails(seed))
    },
  ),

  // propose — the first verb. A first proposal omits `supersedes_result_id`;
  // a counter targets the standing result. propose has its own gates and does
  // NOT pass through the scratchpad-scorable guard (a counter supersedes an
  // existing result, which would otherwise 409 here).
  http.post(
    '*/v1/matches/:matchId/results',
    async ({ params, request }) => {
      await delay(250)
      const seed = findMatch(String(params.matchId))
      if (!seed) return detail('Match not found.', 404)
      const body = (await readJson(request)) as MatchResultsBody
      const error = proposeSeed(
        seed,
        body.games,
        body.supersedes_result_id ?? null,
      )
      if (error) {
        return detail(error.message, error.status)
      }
      return HttpResponse.json(projectMatchDetails(seed), { status: 201 })
    },
  ),

  // accept — the second verb. The `resultId` path param is the concurrency
  // token; the mock current user is the accepting (opposing-side) participant.
  http.post(
    '*/v1/matches/:matchId/results/:resultId/acceptance',
    async ({ params }) => {
      await delay(250)
      const seed = findMatch(String(params.matchId))
      if (!seed) return detail('Match not found.', 404)
      const error = acceptSeed(
        seed,
        String(params.resultId),
        MOCK_CURRENT_USER.id,
      )
      if (error) return detail(error.message, error.status)
      return HttpResponse.json(projectMatchDetails(seed), { status: 201 })
    },
  ),

  // ----- dashboard -------------------------------------------------------
  http.get('*/v1/dashboard', async () => {
    await delay(300)
    const { attention, attention_total_count, waiting_count } =
      projectDashboardAttention(mockMatches)
    // Match the real BFF's participant-filtered COUNT, which doesn't care
    // whether the opponent slot is registered — projectRecentResult drops
    // null-opponent matches from the *display* list, but they still count
    // toward the user's history.
    const completedMatchCount = mockMatches.filter(
      (m) => m.status === 'completed',
    ).length
    const recentResults = mockMatches
      .map(projectRecentResult)
      .filter(notNull)
      .sort((a, b) => b.completed_at.localeCompare(a.completed_at))
      .slice(0, 5)
    return HttpResponse.json({
      attention,
      attention_total_count,
      waiting_count,
      recent_results: recentResults,
      rating: projectRating(mockMatches),
      completed_match_count: completedMatchCount,
      // A seeded live tournament, so the dashboard's tournament panel is
      // visible in `npm run dev`. It is a fixed payload rather than a
      // projection off `tournaments-store`, because that store seeds no LIVE
      // tournament with a cut draw and materialized matches — the only state
      // this panel has anything to say about — and inventing one there would
      // put a phantom live event on the tournaments list too.
      tournaments: [buildDashboardTournament()],
    })
  }),

  // The Administration area's solve ledger (`/admin/schedule-solves`). A fixed
  // 34-row seed rather than a projection off `tournaments-store`: the ledger is
  // a cross-tournament *history*, and the store only keeps each tournament's
  // latest solve — a projection would render a two-row page that can never
  // paginate. The seed references the store's seeded tournaments, so the
  // Tournament links land on detail pages that exist. Paging + the
  // `tournament_id` filter go through the same `pageAdminScheduleSolves` the
  // e2e stubs use. (No permission branch here — the dev session holds
  // `scheduling.view`; tests exercise the 403 with a `server.use` override,
  // as for the other admin endpoints.)
  http.get('*/v1/admin/schedule-solves', async ({ request }) => {
    await delay(200)
    const url = new URL(request.url)
    return HttpResponse.json(
      pageAdminScheduleSolves(mockAdminSolveLedger, {
        tournament_id: url.searchParams.get('tournament_id'),
        page: Number(url.searchParams.get('page') ?? '1'),
        page_size: Number(url.searchParams.get('page_size') ?? '25'),
      }),
    )
  }),

  // ----- geocode (preview pin) -------------------------------------------
  // The "Preview location" lookup (`GET /v1/geocode`). Mirrors the server: a
  // normal address resolves to deterministic coords + a `formatted` label, while
  // the `__unresolvable__` sentinel is the coded 409 both the preview and the
  // create/edit write path answer a zero-result address with
  // (`address_not_geocodable`). It shares the 409 status with the other tournament
  // refusals (league-not-editable, draw-under-way) but is told apart by its coded
  // `detail`. Deterministic per address, so the pin is stable across reloads and
  // testable in vitest.
  //
  // An **empty** `address` is a **422**, not that 409 — the endpoint's query param is
  // `Annotated[str, Query(min_length=1)]`, so an empty one is refused by FastAPI's
  // own validation and never reaches the geocoder. This mock used to answer it with
  // the coded 409, which is inert for the shipped feature (the previewer
  // short-circuits before sending an empty address) but told anyone reproducing the
  // original bug in `npm run dev` the wrong story — a correct bug report about a 422
  // would have looked wrong against a mock that 409s.
  http.get('*/v1/geocode', async ({ request }) => {
    await delay(200)
    const raw = new URL(request.url).searchParams.get('address')
    if (raw === null || raw.length === 0) {
      // FastAPI's own request-validation body: `detail` is an ARRAY of errors, not
      // the object a coded refusal carries.
      return HttpResponse.json(
        {
          detail: [
            raw === null
              ? {
                  type: 'missing',
                  loc: ['query', 'address'],
                  msg: 'Field required',
                  input: null,
                }
              : {
                  type: 'string_too_short',
                  loc: ['query', 'address'],
                  msg: 'String should have at least 1 character',
                  input: '',
                  ctx: { min_length: 1 },
                },
          ],
        },
        { status: 422 },
      )
    }
    // Trimmed only AFTER the length check, as on the server: `min_length` counts
    // the raw characters, so an all-whitespace address really does reach the
    // geocoder — and resolves to nothing, which is the coded 409 below.
    const address = raw.trim()
    if (!address || address.includes('__unresolvable__')) {
      return HttpResponse.json(
        {
          detail: {
            code: 'address_not_geocodable',
            message: 'We couldn’t locate that address.',
          },
        },
        { status: 409 },
      )
    }
    const seed = djb2(address)
    // A small deterministic jitter around Berkeley, so `npm run dev` drops a pin
    // near a plausible place rather than at (0, 0).
    return HttpResponse.json({
      latitude: 37.87 + (seed % 1000) / 100000,
      longitude: -122.27 + ((seed >> 3) % 1000) / 100000,
      formatted: address,
    })
  }),
  // ----- tournaments (admin) ---------------------------------------------
  // Dev-only handlers backed by `tournaments-store`. The seed includes rows
  // owned by the dev user (editable, with events + reservations) and one owned by
  // `league.office` (can_edit: false) so the ownership gating is visible.
  // PATCH/DELETE on a non-owned row (tournament or event) returns 403,
  // mirroring the real API. The list and detail GET both return
  // `TournamentDetailRead` (events included). Event sub-routes are registered
  // before the bare `:tournamentId` so MSW matches them first.
  //
  // Both GETs are also VISIBILITY-scoped (#967): the store serves only the
  // announced tournaments plus the dev user's own, so the seeded foreign draft is
  // missing from the list and 404s (not 403s) on detail — no branch here, because
  // `findTournament` simply does not find it.
  http.get('*/v1/tournaments', async ({ request }) => {
    await delay(250)
    const near = parseNearMe(new URL(request.url).searchParams)
    // The near-me triple is ALL-OR-NOTHING on the server: a partial one is a 422, not a
    // silent default. The mock mirrors that so a UI that sent, say, a lat with no radius
    // meets the same wall in `npm run dev` and vitest that it would in production.
    if (near.error) return detail(near.error, 422)
    return HttpResponse.json(listTournaments(near.filter))
  }),
  http.post('*/v1/tournaments', async ({ request }) => {
    await delay(250)
    const body = (await readJson(request)) as
      | components['schemas']['TournamentCreate']
      | undefined
    if (!body || !body.name?.trim()) return detail('Name is required.', 422)
    return HttpResponse.json(createTournament(body), { status: 201 })
  }),
  // Lifecycle transitions (ADR-0017). The status moves ONLY across a guarded
  // edge: PATCH carries no `status`, so this is the only handler that changes
  // one. It refuses exactly the edges the server refuses — a mock that permitted
  // an illegal jump would let a broken UI look fine.
  http.post(
    '*/v1/tournaments/:tournamentId/transitions',
    async ({ params, request }) => {
      await delay(250)
      const body = (await readJson(request)) as
        | components['schemas']['TournamentTransitionCreate']
        | undefined
      if (!body?.to) return detail('Field required: to', 422)
      const result = transitionTournament(String(params.tournamentId), body.to)
      if (!result.ok) {
        if (result.status === 409) return detail(result.detail, 409)
        return detail(
          result.status === 403
            ? 'Only the creator can move this tournament.'
            : 'Tournament not found.',
          result.status,
        )
      }
      return HttpResponse.json(result.tournament, { status: 201 })
    },
  ),
  http.post(
    '*/v1/tournaments/:tournamentId/events',
    async ({ params, request }) => {
      await delay(250)
      const body = (await readJson(request)) as
        | components['schemas']['TournamentEventCreate']
        | undefined
      const invalid = validateEventBody(body)
      if (invalid) return invalid
      const result = createTournamentEvent(
        String(params.tournamentId),
        body as components['schemas']['TournamentEventCreate'],
      )
      if (!result.ok) {
        return detail(
          result.status === 403
            ? 'Only the creator can add events to this tournament.'
            : 'Tournament not found.',
          result.status,
        )
      }
      return HttpResponse.json(result.event, { status: 201 })
    },
  ),
  // Entries (ADR-0016). Self-registration only: there is no request body — the
  // caller IS the entrant. Registered before the bare `:eventId` routes so MSW
  // never mistakes an entries path for an event path. A withdrawal is addressed
  // by the *entry's* id (the `id` on each entrant), and is idempotent.
  http.post(
    '*/v1/tournaments/:tournamentId/events/:eventId/entries',
    async ({ params }) => {
      await delay(250)
      const result = enterTournamentEvent(
        String(params.tournamentId),
        String(params.eventId),
      )
      if (!result.ok) {
        if (result.status === 400) {
          return detail('Only singles events can be entered.', 400)
        }
        // Every entry refusal is a CODED 409 (ADR-0968):
        // `{"detail": {"code": …, "message": …}}`. The handler doesn't know which
        // refusal it is — the store already said — and the client switches on the
        // code, never on the sentence.
        if (result.status === 409) {
          return HttpResponse.json({ detail: result.refusal }, { status: 409 })
        }
        return detail('Event not found.', 404)
      }
      return HttpResponse.json(result.entrant, { status: 201 })
    },
  ),
  http.delete(
    '*/v1/tournaments/:tournamentId/events/:eventId/entries/:entryId',
    async ({ params }) => {
      await delay(250)
      const result = withdrawTournamentEntry(
        String(params.tournamentId),
        String(params.eventId),
        String(params.entryId),
      )
      if (!result.ok) {
        // The registration window is shut and this entry is still active
        // (ADR-0017) — the store's detail says which of draft/live/archived.
        if (result.status === 409) return detail(result.detail, 409)
        return detail(
          result.status === 403
            ? 'You can only withdraw your own entry.'
            : 'Event not found.',
          result.status,
        )
      }
      return new HttpResponse(null, { status: 204 })
    },
  ),
  // The draw (ADR-0786). Registered before the bare `:eventId` routes, like the
  // entries routes above, so MSW can never mistake a draw path for an event path.
  //
  // Cutting is an EXPLICIT act — nothing else in the mock creates a fixture, and no
  // status change cuts one — and it is refused exactly as the server refuses it: 403
  // (not the owner), 409 (the draw shows evidence of play: a fixture with a winner or a
  // linked match), 422 (this event cannot be planned — an unsupported draw type, no
  // groups, or a group that would get fewer than two entrants). The refusal SENTENCES
  // come from the store, because for the 422 the sentence is the answer: it names the
  // numbers the director has to change.
  http.post(
    '*/v1/tournaments/:tournamentId/events/:eventId/draw',
    async ({ params }) => {
      await delay(250)
      const result = cutTournamentDraw(
        String(params.tournamentId),
        String(params.eventId),
      )
      if (!result.ok) {
        if (result.status === 409 || result.status === 422) {
          return detail(result.detail, result.status)
        }
        return detail(
          result.status === 403
            ? 'Only the creator can cut this draw.'
            : 'Event not found.',
          result.status,
        )
      }
      return HttpResponse.json(result.fixtures, { status: 201 })
    },
  ),
  http.delete(
    '*/v1/tournaments/:tournamentId/events/:eventId/draw',
    async ({ params }) => {
      await delay(250)
      const result = uncutTournamentDraw(
        String(params.tournamentId),
        String(params.eventId),
      )
      if (!result.ok) {
        // The play guard, again: a draw that has been played cannot be removed either.
        if (result.status === 409) return detail(result.detail, 409)
        return detail(
          result.status === 403
            ? 'Only the creator can remove this draw.'
            : 'Event not found.',
          result.status,
        )
      }
      // 204 whether or not there was a draw to remove — this is a DELETE, and asking
      // for a state the resource is already in is a success.
      return new HttpResponse(null, { status: 204 })
    },
  ),
  // The placement (ADR-0790). Registered before the bare `:tournamentId` routes, like the
  // draw routes above, so MSW never mistakes a fixtures path for a tournament path. One
  // hard rule: `table_id` must name a table of this tournament's own catalogue — a 422 on
  // `body.table_id` (`_enforce_table_exists`, `api/app/tournament_placement.py`).
  // Everything else — an out-of-window time, a double-booking — is STORED, not refused;
  // those stay flags-on-read (ADR-0790). The other refusal is a 409 on a finished match,
  // whose placement is frozen. 403 (not the owner), 404 (no such fixture).
  http.patch(
    '*/v1/tournaments/:tournamentId/fixtures/:fixtureId/placement',
    async ({ params, request }) => {
      await delay(250)
      const body = (await readJson(request)) as
        | components['schemas']['TournamentFixturePlacementUpdate']
        | undefined
      const result = placeTournamentFixture(
        String(params.tournamentId),
        String(params.fixtureId),
        body ?? { table_id: null, scheduled_start: null },
      )
      if (!result.ok) {
        if (result.status === 409) return detail(result.detail, 409)
        if (result.status === 422) {
          return HttpResponse.json(
            {
              detail: [
                {
                  type: 'value_error',
                  loc: ['body', 'table_id'],
                  msg: result.detail,
                  input: body?.table_id ?? null,
                },
              ],
            },
            { status: 422 },
          )
        }
        return detail(
          result.status === 403
            ? 'Only the creator can place a match.'
            : 'Fixture not found.',
          result.status,
        )
      }
      return HttpResponse.json(result.fixture)
    },
  ),
  // The schedule solver (ADR "the schedule is solved; the call is pinned").
  // Registered before the bare `:tournamentId` routes, like the fixtures route
  // above. One verb, no body: POST queues a run — the owner's Run-scheduler
  // button — and answers **202** with the ledger row that will carry the outcome.
  // The outcome itself is read off the detail's `latest_schedule_solve`, which the
  // store's read tick walks queued → running → succeeded (see `tournaments-store`).
  // The 422 is CODED (`no_drawn_events`, the ADR-0968 shape): the client switches
  // on the code and owns its copy; the message is the fallback sentence.
  http.post(
    '*/v1/tournaments/:tournamentId/schedule/solves',
    async ({ params }) => {
      await delay(250)
      const result = requestTournamentScheduleSolve(String(params.tournamentId))
      if (!result.ok) {
        if (result.status === 422) {
          return HttpResponse.json(
            { detail: { code: result.code, message: result.message } },
            { status: 422 },
          )
        }
        return detail(
          result.status === 403
            ? 'Only the creator can run the scheduler.'
            : 'Tournament not found.',
          result.status,
        )
      }
      return HttpResponse.json(result.solve, { status: 202 })
    },
  ),
  // The **schedule preview** (ADR "a schedule preview is a non-persistent solve
  // over a synthetic field"). Three ephemeral endpoints, registered before the
  // bare `:tournamentId` routes like the solve/fixtures routes above. Enqueue
  // returns a token + the instant structure (202); the poll walks the token
  // queued → running → done BY THE READS (the mock has no worker), so the modal's
  // streaming resolves at the polling cadence; cancel drops the job (204,
  // best-effort/idempotent). A preview persists nothing, so this touches the
  // preview store alone, never the tournaments store.
  http.post(
    '*/v1/tournaments/:tournamentId/schedule/preview',
    async ({ request }) => {
      await delay(150)
      const body = (await readJson(request)) as
        | components['schemas']['PreviewRequest']
        | null
      return HttpResponse.json(enqueueSchedulePreview(body ?? null), {
        status: 202,
      })
    },
  ),
  http.get(
    '*/v1/tournaments/:tournamentId/schedule/preview/:token',
    async ({ params }) => {
      await delay(150)
      return HttpResponse.json(readSchedulePreview(String(params.token)))
    },
  ),
  http.delete(
    '*/v1/tournaments/:tournamentId/schedule/preview/:token',
    async ({ params }) => {
      await delay(100)
      cancelSchedulePreview(String(params.token))
      // 204 whether or not the token was still live — cancel is best-effort and
      // idempotent, like the real route.
      return new HttpResponse(null, { status: 204 })
    },
  ),
  http.patch(
    '*/v1/tournaments/:tournamentId/events/:eventId',
    async ({ params, request }) => {
      await delay(250)
      const body = (await readJson(request)) as
        | components['schemas']['TournamentEventUpdate']
        | undefined
      const invalid = validateEventBody(body)
      if (invalid) return invalid
      const result = updateTournamentEvent(
        String(params.tournamentId),
        String(params.eventId),
        body ?? {},
      )
      if (!result.ok) {
        // The group-set freeze (ADR-0786): this PATCH would add or remove a reservation
        // — and therefore the group mapped to it — on an event whose draw is cut,
        // orphaning the fixtures drawn into it. The store's sentence says so — naming
        // the groups — and says how to get out of it.
        if (result.status === 409) return detail(result.detail, 409)
        // An entry citing an id this event does not have (ADR 20260801). Shaped as a
        // **field** refusal — FastAPI's per-field array, `loc` naming the entry's index —
        // because that is what the route really sends and what `validationFields`
        // (`src/api/client.ts`) reads to blame the reservation card.
        if (result.status === 422) {
          return HttpResponse.json(
            {
              detail: [
                {
                  type: 'value_error',
                  loc: ['body', 'reservations', result.index, 'id'],
                  msg: result.detail,
                  input: result.reservationId,
                },
              ],
            },
            { status: 422 },
          )
        }
        return detail(
          result.status === 403
            ? 'Only the creator can edit this event.'
            : 'Event not found.',
          result.status,
        )
      }
      return HttpResponse.json(result.event)
    },
  ),
  http.delete(
    '*/v1/tournaments/:tournamentId/events/:eventId',
    async ({ params }) => {
      await delay(250)
      const result = deleteTournamentEvent(
        String(params.tournamentId),
        String(params.eventId),
      )
      if (!result.ok) {
        return detail(
          result.status === 403
            ? 'Only the creator can delete this event.'
            : 'Event not found.',
          result.status,
        )
      }
      return new HttpResponse(null, { status: 204 })
    },
  ),
  http.get('*/v1/tournaments/:tournamentId', async ({ params }) => {
    await delay(200)
    const found = findTournament(String(params.tournamentId))
    if (!found) return detail('Tournament not found.', 404)
    return HttpResponse.json(found)
  }),
  http.patch('*/v1/tournaments/:tournamentId', async ({ params, request }) => {
    await delay(250)
    const body = (await readJson(request)) as
      | components['schemas']['TournamentUpdate']
      | undefined
    const result = updateTournament(String(params.tournamentId), body ?? {})
    if (!result.ok) {
      // The catalogue's named refusal (ADR 20260801): this edit would remove a table
      // matches are placed at, and nobody opted in. Bare prose, carrying the domain's
      // own sentence — the client shows it verbatim — and nothing was written.
      if (result.status === 409) return detail(result.detail, 409)
      // An entry citing an id this tournament's catalogue does not hold. Shaped as a
      // **field** refusal — FastAPI's per-field array, `loc` naming the entry's index —
      // because that is what the route really sends and what `validationFields`
      // (`src/api/client.ts`) reads to blame the Tables row.
      if (result.status === 422) {
        return HttpResponse.json(
          {
            detail: [
              {
                type: 'value_error',
                loc: ['body', 'table_catalogue', result.index, 'id'],
                msg: result.detail,
                input: result.tableId,
              },
            ],
          },
          { status: 422 },
        )
      }
      return detail(
        result.status === 403
          ? 'Only the creator can edit this tournament.'
          : 'Tournament not found.',
        result.status,
      )
    }
    return HttpResponse.json(result.tournament)
  }),
  http.delete('*/v1/tournaments/:tournamentId', async ({ params }) => {
    await delay(250)
    const result = deleteTournamentSeed(String(params.tournamentId))
    if (!result.ok) {
      return detail(
        result.status === 403
          ? 'Only the creator can delete this tournament.'
          : 'Tournament not found.',
        result.status,
      )
    }
    return new HttpResponse(null, { status: 204 })
  }),
  ...notificationHandlers,

  ...rbacHandlersFor(state),
]
