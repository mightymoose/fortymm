import { faker } from '@faker-js/faker'
import type { components } from '@/api/schema'
import { MOCK_DEFAULT_LEAGUE } from '@/mocks/match-store'

type ComponentHealth = components['schemas']['ComponentHealth']
type HealthResponse = components['schemas']['HealthResponse']
type SessionUser = components['schemas']['SessionUser']
type SessionResponse = components['schemas']['SessionResponse']
type Permission = components['schemas']['PermissionRead']
type Role = components['schemas']['RoleRead']
type RbacUser = components['schemas']['RbacUserRead']
type Player = components['schemas']['PlayerRead']
type MatchDetails = components['schemas']['app__schemas__match__MatchDetails']
type MatchDetailsSide = components['schemas']['MatchDetailsSide']
type MatchListRow = components['schemas']['MatchListRow']
type MatchListResponse = components['schemas']['MatchListResponse']
type MatchStatus = components['schemas']['MatchStatus']
type DashboardResponse = components['schemas']['DashboardResponse']
type DashboardScoreBanner = components['schemas']['DashboardScoreBanner']
type DashboardNextMatch = components['schemas']['DashboardNextMatch']
type DashboardRecentResult = components['schemas']['DashboardRecentResult']
type DashboardRating = components['schemas']['DashboardRating']

function fastCheck(overrides: Partial<ComponentHealth> = {}): ComponentHealth {
  return {
    healthy: true,
    latency_ms: faker.number.float({ min: 1, max: 80, fractionDigits: 1 }),
    error: null,
    ...overrides,
  }
}

export function redisCheck(
  overrides: Partial<ComponentHealth> = {},
): ComponentHealth {
  return fastCheck(overrides)
}

export function databaseCheck(
  overrides: Partial<ComponentHealth> = {},
): ComponentHealth {
  return fastCheck(overrides)
}

export function solverCheck(
  overrides: Partial<ComponentHealth> = {},
): ComponentHealth {
  return fastCheck({
    latency_ms: faker.number.float({ min: 30, max: 250, fractionDigits: 1 }),
    ...overrides,
  })
}

export function healthCheck(
  overrides: Partial<HealthResponse> = {},
): HealthResponse {
  return {
    redis: redisCheck(),
    database: databaseCheck(),
    solver: solverCheck(),
    ...overrides,
  }
}

export function sessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    username: faker.internet.username().toLowerCase(),
    permissions: [],
    email: null,
    confirmed_at: null,
    pending_email: null,
    ...overrides,
  }
}

export function sessionResponse(
  overrides: { user?: Partial<SessionUser> } = {},
): SessionResponse {
  return {
    data: { user: sessionUser(overrides.user) },
  }
}

const ISO = '2026-05-12T09:00:00Z'

let counter = 0
function nextId(prefix: string) {
  counter += 1
  return `${prefix}_${faker.string.alphanumeric(6)}_${counter}`
}

export function permission(overrides: Partial<Permission> = {}): Permission {
  const name = overrides.name ?? `${faker.word.noun().toLowerCase()}.${faker.word.verb().toLowerCase()}`
  return {
    id: nextId('p'),
    name,
    description: `Mock permission ${name}`,
    created_at: ISO,
    updated_at: ISO,
    ...overrides,
  }
}

export function role(overrides: Partial<Role> = {}): Role {
  return {
    id: nextId('r'),
    name: `Role ${faker.word.adjective()}`,
    description: 'Mock role',
    permission_ids: [],
    created_at: ISO,
    updated_at: ISO,
    ...overrides,
  }
}

export function rbacUser(overrides: Partial<RbacUser> = {}): RbacUser {
  return {
    id: nextId('u'),
    username: faker.internet.username().toLowerCase(),
    role_ids: [],
    created_at: ISO,
    ...overrides,
  }
}

export function player(overrides: Partial<Player> = {}): Player {
  return {
    id: nextId('pl'),
    username: faker.internet.username().toLowerCase(),
    ...overrides,
  }
}

/** Build a default `[mySide, opponentSide]` pair (or `[mySide]` for solo
 * matches). Shared by `matchDetails` and `matchListRow` so both factories
 * agree on the canonical "rita.kovac vs faker-name" shape. */
function defaultSides(opponentName: string | null): {
  mySide: MatchDetailsSide
  // Always present: a real opponent, or the player-less sentinel "No opponent"
  // side that keeps an opponent-less match scorable (mirrors the API).
  opponentSide: MatchDetailsSide
} {
  const mySide: MatchDetailsSide = {
    side_number: 1,
    players: [
      {
        user_id: nextId('u'),
        username: 'rita.kovac',
        is_current_user: true,
      },
    ],
    games_won: 0,
    won: null,
    is_current_user_side: true,
  }
  const opponentSide: MatchDetailsSide = {
    side_number: 2,
    // No opponent → an empty (player-less) sentinel side.
    players:
      opponentName === null
        ? []
        : [
            {
              user_id: nextId('u'),
              username: opponentName,
              is_current_user: false,
            },
          ],
    games_won: 0,
    won: null,
    is_current_user_side: false,
  }
  return { mySide, opponentSide }
}

/**
 * `MatchDetails` factory. Defaults to a fresh `in_progress` 1v1 with the
 * current user on side 1, a single opponent on side 2, and game 1 unscored
 * — the shape the BFF returns straight after `POST /v1/matches`.
 */
export function matchDetails(
  overrides: Partial<MatchDetails> = {},
): MatchDetails {
  const id = overrides.id ?? nextId('m')
  const bestOf = overrides.best_of ?? 5
  const status = overrides.status ?? 'in_progress'
  // Mirror the backend scoreboard-status mapping so an overridden `status`
  // keeps the derived `data.scoreboard` in sync (disputed/voided → final).
  const scoreboardStatus =
    status === 'pending' ? 'scheduled' : status === 'in_progress' ? 'live' : 'final'
  const { mySide, opponentSide } = defaultSides(
    faker.internet.username().toLowerCase(),
  )
  return {
    id,
    status,
    status_label: 'Live',
    league: MOCK_DEFAULT_LEAGUE,
    best_of: bestOf,
    games_to_win: Math.ceil(bestOf / 2),
    team_size: 1,
    affects_rating: false,
    created_at: ISO,
    sides: [mySide, opponentSide],
    // Games are lazily inserted by the score-write endpoints; a fresh match
    // has no game rows yet, but `current_game` still points at the next slot.
    games: [],
    current_game: { game_number: 1 },
    can_score: true,
    can_finalize: false,
    can_confirm: false,
    signatures: [],
    recent_form: [mySide, opponentSide]
      .filter((s) => s.players.length > 0)
      .map((s) => ({
        user_id: s.players[0].user_id,
        recent_results: [],
        rating_before: null,
        rating_history: [],
        career_matches_before: 0,
        career_wins_before: 0,
      })),
    head_to_head: {
      total_meetings: 0,
      side_1_wins: 0,
      side_2_wins: 0,
      recent_meetings: [],
    },
    data: { scoreboard: { status: scoreboardStatus } },
    ...overrides,
  }
}

/** Row-shaped projection for the /matches list. Defaults mirror an
 * in_progress 1v1 against a registered opponent with one trailing
 * un-scored game. Pass `opponent` as a shorthand to set the side-2
 * player without spelling out `sides`. */
export function matchListRow(
  overrides: Partial<MatchListRow> & { opponent?: string | null } = {},
): MatchListRow {
  const { opponent, ...rest } = overrides
  const opponentName =
    opponent === undefined
      ? faker.internet.username().toLowerCase()
      : opponent
  const { mySide, opponentSide } = defaultSides(opponentName)
  return {
    id: nextId('m'),
    status: 'in_progress',
    status_label: 'Live',
    league: MOCK_DEFAULT_LEAGUE,
    sides: [mySide, opponentSide],
    best_of: 5,
    created_at: ISO,
    current_game_number: 1,
    can_score: true,
    can_confirm: false,
    ...rest,
  }
}

const ALL_STATUSES: MatchStatus[] = [
  'pending',
  'in_progress',
  'completed',
  'disputed',
  'voided',
]

export function matchListResponse(
  overrides: Partial<MatchListResponse> = {},
): MatchListResponse {
  const items = overrides.items ?? []
  const baseCounts: Record<string, number> = Object.fromEntries(
    ALL_STATUSES.map((s) => [s, 0]),
  )
  for (const item of items) {
    baseCounts[item.status] = (baseCounts[item.status] ?? 0) + 1
  }
  return {
    items,
    page: 1,
    page_size: 25,
    total: items.length,
    status_counts: baseCounts,
    ...overrides,
  }
}

export function dashboardResponse(
  overrides: Partial<DashboardResponse> = {},
): DashboardResponse {
  const recent_results = overrides.recent_results ?? []
  return {
    score_banners: [],
    next_match: null,
    recent_results,
    rating: dashboardRating(),
    // Default mirrors the visible list. Override directly to model the
    // "history exceeds the recent window" case the guest banner cares about.
    completed_match_count: recent_results.length,
    ...overrides,
  }
}

export function dashboardRating(
  overrides: Partial<DashboardRating> = {},
): DashboardRating {
  return {
    league_id: nextId('lg'),
    league_name: 'FortyMM',
    strategy_key: 'glicko2',
    current: 1500,
    delta: 0,
    peak: 1500,
    percentile: null,
    spark_data: [],
    streak: null,
    stats: [
      { label: 'RD', value: '350' },
      { label: 'Volatility', value: '0.060' },
    ],
    ...overrides,
  }
}

export function dashboardScoreBanner(
  overrides: Partial<DashboardScoreBanner> = {},
): DashboardScoreBanner {
  return {
    match_id: nextId('m'),
    opponent_username: faker.internet.username().toLowerCase(),
    current_game_number: 1,
    ...overrides,
  }
}

export function dashboardNextMatch(
  overrides: Partial<DashboardNextMatch> = {},
): DashboardNextMatch {
  return {
    match_id: nextId('m'),
    opponent_username: faker.internet.username().toLowerCase(),
    best_of: 5,
    created_at: ISO,
    ...overrides,
  }
}

export function dashboardRecentResult(
  overrides: Partial<DashboardRecentResult> = {},
): DashboardRecentResult {
  return {
    match_id: nextId('m'),
    opponent_username: faker.internet.username().toLowerCase(),
    is_win: true,
    my_games_won: 3,
    opponent_games_won: 1,
    completed_at: ISO,
    ...overrides,
  }
}
