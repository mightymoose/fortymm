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
  if (seed.opponent === null) {
    return detail("This match has no opponent and can't be scored.", 422)
  }
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
  http.patch('*/v1/me', async ({ request }) => {
    const body = (await readJson(request)) as { username?: string } | undefined
    const next = body?.username?.trim() ?? ''
    if (!next) return detail('Username is required.')
    mockSession.data.user = { ...mockSession.data.user, username: next }
    return HttpResponse.json(mockSession)
  }),
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
      scoped = scoped.filter((m) =>
        (m.opponent?.username ?? '').toLowerCase().includes(q),
      )
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
