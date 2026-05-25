import { delay, http, HttpResponse } from 'msw'
import type { components } from '@/api/schema'
import { healthCheck, player, sessionResponse } from '@/test/factories'
import {
  findMatch,
  mockMatches,
  newMatchSeed,
  projectListRow,
  projectMatchDetails,
  projectNextMatch,
  projectRating,
  projectRecentResult,
  projectScoreBanner,
  reconcile,
  statusCountsOf,
  validateScore,
  type SeedMatch,
} from './match-store'
import { createRbacState, dispatchRbac } from './rbac-engine'
import { DEMO_SEED } from './rbac-store'

export const mockSession = sessionResponse({ user: { username: 'rita.kovac' } })
export const mockHealthy = healthCheck()

export const mockPlayers = [
  player({ username: 'nguyen.t', rating: 1842 }),
  player({ username: 'okafor.d', rating: 1721 }),
  player({ username: 'silva.r', rating: 1605 }),
  player({ username: 'patel.m', rating: 1933 }),
  player({ username: 'johansen.a', rating: 1488 }),
  player({ username: 'chen.w', rating: 1547 }),
  player({ username: 'park.j', rating: null }),
]

// The recent-opponents endpoint is capped at six chips; the dev/test mock just
// serves the first slice in roster order.
export const mockRecentOpponents = mockPlayers.slice(0, 6)

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

// ----- /v1/players helpers --------------------------------------------------
//
// The dev/test mock roster + summary projector. Keeps the current user
// (rita.kovac, MOCK_CURRENT_USER) findable so /players/$myId resolves, and
// derives plausible W-L + form deterministically so reloads stay stable.

type PlayerSummary = components['schemas']['PlayerSummary']
type PlayerMatchRow = components['schemas']['PlayerMatchRow']

const MOCK_CURRENT_PLAYER_ID = 'u-me' // matches MOCK_CURRENT_USER.id in match-store

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

function summarizePlayer(p: {
  id: string
  username: string
  rating?: number | null
}): PlayerSummary {
  const rating = p.rating ?? null
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
        if (recent.length < 5) recent.push('W')
      } else if (s2 >= target) {
        losses += 1
        if (recent.length < 5) recent.push('L')
      }
    }
    return {
      id: p.id,
      username: p.username,
      rating,
      wins,
      losses,
      form: recent.join(''),
    }
  }
  const seed = djb2(p.username)
  const wins = 5 + (seed % 25)
  const losses = 2 + ((seed * 7) % 12)
  const form = Array.from({ length: 5 }, (_, i) =>
    (seed + i * 3) % 3 === 0 ? 'L' : 'W',
  ).join('')
  return {
    id: p.id,
    username: p.username,
    rating,
    wins,
    losses,
    form,
  }
}

/** Mirrors the backend's `LIST_DEFAULT_PAGE_SIZE` in `api/app/players.py`
 * and the FE's `PAGE_SIZE` in `player-profile.tsx`. If those drift, the
 * FE's `initialData` cache-key won't match the bundle's `page_size` and
 * we'll waste a second fetch on mount — the whole point of bundling. */
const BUNDLED_MATCHES_PAGE_SIZE = 25

/** PlayerDetail = PlayerSummary + first-page matches. Both profile
 * endpoints (`/v1/players/{id}` and `/v1/p/players/{username}`) return
 * this so the FE paints the profile page in one round trip; pagination
 * beyond page 1 falls through to `/v1/players/{id}/matches`. */
function playerDetail(p: {
  id: string
  username: string
  rating?: number | null
}) {
  const summary = summarizePlayer(p)
  const rows = projectPlayerMatches({ id: p.id, username: p.username })
  return {
    ...summary,
    matches: {
      items: rows.slice(0, BUNDLED_MATCHES_PAGE_SIZE),
      page: 1,
      page_size: BUNDLED_MATCHES_PAGE_SIZE,
      total: rows.length,
    },
  }
}

/** Shared by the authed and public per-player-matches handlers — projects
 * the player's matches and slices to the requested page. */
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

  return myMatches
    .slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((m): PlayerMatchRow => {
      // The "perspective" player is on side 1 if they're the current user,
      // side 2 otherwise (since mocks always put rita on side 1).
      const onSide1 = isMe
      const opponentUsername = onSide1
        ? (m.opponent?.username ?? null)
        : mockSession.data.user.username
      const opponentId = onSide1
        ? (m.opponent?.id ?? null)
        : MOCK_CURRENT_PLAYER_ID
      const sets = m.games
        .filter((g): g is typeof g & { score: NonNullable<typeof g.score> } =>
          g.score !== null,
        )
        .map((g) => ({
          mine: onSide1 ? g.score.side_1_points : g.score.side_2_points,
          theirs: onSide1 ? g.score.side_2_points : g.score.side_1_points,
        }))
      const target = Math.ceil(m.best_of / 2)
      let s1 = 0
      let s2 = 0
      for (const s of sets) {
        if (s.mine > s.theirs) s1 += 1
        else if (s.theirs > s.mine) s2 += 1
      }
      let result: 'W' | 'L' | null = null
      if (m.status === 'completed') {
        if (s1 >= target) result = 'W'
        else if (s2 >= target) result = 'L'
      }
      return {
        id: m.id,
        status: m.status,
        created_at: m.created_at,
        opponent: { id: opponentId, username: opponentUsername },
        sets,
        result,
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

async function rbacHandler({ request }: { request: Request }) {
  const url = new URL(request.url)
  const path = url.pathname.replace(/^\/api/, '')
  const body = await readJson(request)
  const result = dispatchRbac(state, request.method, path, body)
  if (!result) {
    return HttpResponse.json({ detail: `unmocked ${request.method} ${path}` }, { status: 404 })
  }
  if (result.status === 204) return new HttpResponse(null, { status: 204 })
  return HttpResponse.json(result.body as Parameters<typeof HttpResponse.json>[0], {
    status: result.status,
  })
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

function detail(message: string, status = 422) {
  return HttpResponse.json({ detail: message }, { status })
}

/** Apply a score write to an existing game, recompute the seed, and return
 * the projected MatchDetails. Validates against the same TT rules the API
 * enforces so the FE inline-error tests see the same messages. */
function applyScore(
  seed: SeedMatch,
  gameId: string,
  body: MatchScoreBody,
  options: { scoreId?: string } = {},
): Response {
  // A no-opponent match is scorable against its player-less sentinel side
  // (mirrors the API), so there's no opponent gate here.
  if (seed.status === 'disputed' || seed.status === 'voided') {
    return detail('This match is no longer scorable.', 409)
  }
  const game = seed.games.find((g) => g.id === gameId)
  if (!game) return detail('Game not found.', 404)
  if (options.scoreId !== undefined) {
    if (game.score === null || game.score.id !== options.scoreId) {
      return detail('Score not found.', 404)
    }
  } else if (game.score !== null) {
    return detail('This game has already been scored.', 409)
  }

  const message = validateScore(body.side_1_points, body.side_2_points)
  if (message) return detail(message, 422)

  game.score = {
    id: options.scoreId ?? `s-${seed.id}-${game.game_number}-${Date.now().toString(36)}`,
    side_1_points: body.side_1_points,
    side_2_points: body.side_2_points,
  }
  reconcile(seed)
  return HttpResponse.json(projectMatchDetails(seed))
}

function notNull<T>(value: T | null): value is T {
  return value !== null
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
  http.get('*/v1/players/:playerId', async ({ params }) => {
    await delay(200)
    const playerId = String(params.playerId)
    const player = mockPlayerRoster().find((p) => p.id === playerId)
    if (!player) {
      return HttpResponse.json(
        { detail: 'Player not found.' },
        { status: 404 },
      )
    }
    return HttpResponse.json(playerDetail(player))
  }),
  http.get('*/v1/p/players/:username', async ({ params }) => {
    await delay(200)
    const username = String(params.username)
    const player = mockPlayerRoster().find((p) => p.username === username)
    if (!player) {
      return HttpResponse.json(
        { detail: 'Player not found.' },
        { status: 404 },
      )
    }
    return HttpResponse.json(playerDetail(player))
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
    mockSession.data.user = {
      ...mockSession.data.user,
      email: mockSession.data.user.email ?? 'rita@example.com',
      confirmed_at:
        mockSession.data.user.confirmed_at ?? new Date().toISOString(),
    }
    return HttpResponse.json(mockSession)
  }),
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
      ? scoped.filter((m) => m.status === statusFilter)
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
    const filtered = statusFilter
      ? scoped.filter((m) => m.status === statusFilter)
      : scoped

    const start = (page - 1) * pageSize
    const slice = filtered.slice(start, start + pageSize)
    return HttpResponse.json({
      items: slice.map(projectListRow),
      page,
      page_size: pageSize,
      total: filtered.length,
      status_counts: statusCountsOf(scoped),
    })
  }),

  http.get('*/v1/matches/:matchId', async ({ params }) => {
    await delay(200)
    const seed = findMatch(String(params.matchId))
    if (!seed) return detail('Match not found.', 404)
    return HttpResponse.json(projectMatchDetails(seed))
  }),

  http.post(
    '*/v1/matches/:matchId/games/:gameId/scores',
    async ({ params, request }) => {
      await delay(250)
      const seed = findMatch(String(params.matchId))
      if (!seed) return detail('Match not found.', 404)
      const body = (await readJson(request)) as MatchScoreBody
      return applyScore(seed, String(params.gameId), body)
    },
  ),

  http.put(
    '*/v1/matches/:matchId/games/:gameId/scores/:scoreId',
    async ({ params, request }) => {
      await delay(250)
      const seed = findMatch(String(params.matchId))
      if (!seed) return detail('Match not found.', 404)
      const body = (await readJson(request)) as MatchScoreBody
      return applyScore(seed, String(params.gameId), body, {
        scoreId: String(params.scoreId),
      })
    },
  ),

  // ----- dashboard -------------------------------------------------------
  http.get('*/v1/dashboard', async () => {
    await delay(300)
    const scoreBanners = mockMatches.map(projectScoreBanner).filter(notNull)
    const nextMatch =
      mockMatches.map(projectNextMatch).find(notNull) ?? null
    const recentResults = mockMatches
      .map(projectRecentResult)
      .filter(notNull)
      .sort((a, b) => b.completed_at.localeCompare(a.completed_at))
      .slice(0, 5)
    return HttpResponse.json({
      score_banners: scoreBanners,
      next_match: nextMatch,
      recent_results: recentResults,
      rating: projectRating(mockMatches),
    })
  }),

  ...RBAC_PATHS.flatMap((path) => [
    http.get(path, rbacHandler),
    http.post(path, rbacHandler),
    http.patch(path, rbacHandler),
    http.put(path, rbacHandler),
    http.delete(path, rbacHandler),
  ]),
]
