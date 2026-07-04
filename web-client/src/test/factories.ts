import { faker } from '@faker-js/faker'
import type { components } from '@/api/schema'
import {
  LIVE_NEGOTIATION,
  MOCK_DEFAULT_LEAGUE,
  seedScoreboardStatus,
} from '@/mocks/match-store'

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
type DashboardAttentionItem = components['schemas']['DashboardAttentionItem']
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
  // Derive `data.scoreboard.status` the same way the mock store (and backend
  // mapper) do, so an overridden `status` stays in sync (disputed/voided → final).
  const scoreboardStatus = seedScoreboardStatus(status)
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
    negotiation: LIVE_NEGOTIATION,
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
    affects_rating: true,
    created_at: ISO,
    current_game_number: 1,
    can_score: true,
    negotiation: LIVE_NEGOTIATION,
    attention: null,
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
  // Mirror the server: a posted-but-unconfirmed result is an in_progress row
  // labelled "Awaiting acceptance". Count it under its own bucket and peel it
  // out of in_progress so status_counts.in_progress reads as true-live (#381).
  let awaiting = 0
  for (const item of items) {
    if (
      item.status === 'in_progress' &&
      item.status_label === 'Awaiting acceptance'
    ) {
      awaiting += 1
    } else {
      baseCounts[item.status] = (baseCounts[item.status] ?? 0) + 1
    }
  }
  const attention_count =
    overrides.attention_count ??
    items.filter((item) => item.attention !== null).length
  return {
    items,
    page: 1,
    page_size: 25,
    total: items.length,
    status_counts: baseCounts,
    attention_count,
    awaiting_acceptance_count: awaiting,
    ...overrides,
  }
}

export function dashboardResponse(
  overrides: Partial<DashboardResponse> = {},
): DashboardResponse {
  const recent_results = overrides.recent_results ?? []
  const attention = overrides.attention ?? []
  return {
    attention,
    // Mirrors the returned rows by default (no server-side cap in play).
    // Override to model a capped panel with extra "+N more" overflow.
    attention_total_count: attention.length,
    waiting_count: 0,
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

export function dashboardAttentionItem(
  overrides: Partial<DashboardAttentionItem> = {},
): DashboardAttentionItem {
  return {
    match_id: nextId('m'),
    opponent_username: faker.internet.username().toLowerCase(),
    kind: 'score',
    affects_rating: true,
    current_game_number: 1,
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

// ----- notifications -------------------------------------------------------

type NotificationItem = components['schemas']['NotificationItem']
type NotificationFeed = components['schemas']['NotificationFeed']
type NotificationPreferences = components['schemas']['NotificationPreferences']
type NotificationChannelState = components['schemas']['NotificationChannelState']
type NotificationCategoryPreference =
  components['schemas']['NotificationCategoryPreference']
type NotificationChannel = components['schemas']['NotificationChannel']
type NotificationCategory = components['schemas']['NotificationCategory']
type BroadcastRecipientList = components['schemas']['BroadcastRecipientList']
type BroadcastResponse = components['schemas']['BroadcastResponse']
type NotificationTaxonomy = components['schemas']['NotificationTaxonomy']
type NotificationTypeInfo = components['schemas']['NotificationTypeInfo']
type NotificationChannelInfo = components['schemas']['NotificationChannelInfo']

const NOTIF_CHANNELS: NotificationChannel[] = ['in_app', 'push', 'email', 'sms']
const NOTIF_CATEGORIES: NotificationCategory[] = [
  'match_reminder',
  'rating_change',
  'tournament',
  'opponent',
  'result_confirm',
]

export function notificationItem(
  overrides: Partial<NotificationItem> = {},
): NotificationItem {
  return {
    id: nextId('n'),
    category: 'result_confirm',
    title: 'Accept your score',
    body: 'def. Patel, M. — you logged 3–1. Tap to accept.',
    link: '/matches/m-1',
    action_label: 'Review',
    delta: null,
    read_at: null,
    created_at: ISO,
    ...overrides,
  }
}

export function notificationFeed(
  overrides: Partial<NotificationFeed> = {},
): NotificationFeed {
  return {
    items: [notificationItem()],
    unread_count: 1,
    ...overrides,
  }
}

function notifChannelDestination(channel: NotificationChannel): string {
  if (channel === 'in_app') return 'Always on, in your feed'
  if (channel === 'push') return '1 device'
  if (channel === 'email') return 'you@fortymm.club'
  return 'Not available yet'
}

function notifChannelState(
  channel: NotificationChannel,
): NotificationChannelState {
  const available = channel !== 'sms'
  const locked = channel === 'in_app'
  return {
    channel,
    enabled: locked || available,
    available,
    locked,
    destination: notifChannelDestination(channel),
    // The default scenario is a fully set-up account (email confirmed, a push
    // device registered), matching the configured destinations above. The
    // nudge tests flip this per channel.
    setup_required: false,
  }
}

function notifCategoryPref(
  category: NotificationCategory,
): NotificationCategoryPreference {
  return {
    category,
    cells: NOTIF_CHANNELS.map((channel) => {
      const locked =
        category === 'match_reminder' &&
        (channel === 'in_app' || channel === 'push')
      const available = channel !== 'sms'
      return { channel, enabled: locked ? true : available, locked }
    }),
  }
}

/** The default, no-overrides preferences matrix, mirroring the server's
 * resolved defaults. */
export function notificationPreferences(
  overrides: Partial<NotificationPreferences> = {},
): NotificationPreferences {
  return {
    channels: NOTIF_CHANNELS.map(notifChannelState),
    categories: NOTIF_CATEGORIES.map(notifCategoryPref),
    ...overrides,
  }
}

// The server taxonomy's labels/short/order, mirrored for tests. These MUST stay
// in sync with the strings the old CATEGORY_META/CHANNEL_META carried, since the
// page objects query by visible label text.
const NOTIF_TYPE_INFOS: NotificationTypeInfo[] = [
  { key: 'match_reminder', label: 'Match reminders', short: 'Match' },
  { key: 'rating_change', label: 'Rating changes', short: 'Rating' },
  { key: 'tournament', label: 'Tournament news', short: 'Tourney' },
  { key: 'opponent', label: 'Challenges & friends', short: 'Social' },
  { key: 'result_confirm', label: 'Score confirmations', short: 'Scores' },
]

const NOTIF_CHANNEL_INFOS: NotificationChannelInfo[] = [
  { key: 'in_app', label: 'In-app', available: true },
  { key: 'push', label: 'Push', available: true },
  { key: 'email', label: 'Email', available: true },
  { key: 'sms', label: 'SMS', available: false },
]

export function notificationTypeInfo(
  overrides: Partial<NotificationTypeInfo> = {},
): NotificationTypeInfo {
  return { ...NOTIF_TYPE_INFOS[0], ...overrides }
}

export function notificationChannelInfo(
  overrides: Partial<NotificationChannelInfo> = {},
): NotificationChannelInfo {
  return { ...NOTIF_CHANNEL_INFOS[0], ...overrides }
}

/** The display taxonomy — the server-owned, ordered category + channel labels
 * every notification surface renders. */
export function notificationTaxonomy(
  overrides: Partial<NotificationTaxonomy> = {},
): NotificationTaxonomy {
  return {
    types: NOTIF_TYPE_INFOS.map((t) => ({ ...t })),
    channels: NOTIF_CHANNEL_INFOS.map((c) => ({ ...c })),
    ...overrides,
  }
}

export function broadcastRecipientList(
  overrides: Partial<BroadcastRecipientList> = {},
): BroadcastRecipientList {
  return {
    recipients: [
      { id: nextId('u'), username: 'nguyen.t' },
      { id: nextId('u'), username: 'okafor.d' },
    ],
    total: 2,
    ...overrides,
  }
}

export function broadcastResponse(
  overrides: Partial<BroadcastResponse> = {},
): BroadcastResponse {
  return {
    recipients: 2,
    queued: true,
    ...overrides,
  }
}
