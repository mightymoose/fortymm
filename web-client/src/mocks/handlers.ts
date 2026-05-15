import { delay, http, HttpResponse } from 'msw'
import type { components } from '@/api/schema'
import {
  healthCheck,
  matchResponse,
  player,
  sessionResponse,
} from '@/test/factories'
import { createRbacState, dispatchRbac } from './rbac-engine'
import { DEMO_SEED } from './rbac-store'

export const mockSession = sessionResponse({ user: { username: 'rita.kovac' } })
export const mockHealthy = healthCheck()

export const mockPlayers = [
  player({ username: 'nguyen.t' }),
  player({ username: 'okafor.d' }),
  player({ username: 'silva.r' }),
  player({ username: 'patel.m' }),
  player({ username: 'johansen.a' }),
  player({ username: 'chen.w' }),
  player({ username: 'park.j' }),
]

// The recent-opponents endpoint is capped at six chips; the dev/test mock just
// serves the first slice in roster order.
export const mockRecentOpponents = mockPlayers.slice(0, 6)

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

export const handlers = [
  http.get('*/v1/health', async () => {
    await delay(400)
    return HttpResponse.json(mockHealthy)
  }),
  http.get('*/v1/session', async () => {
    await delay(600)
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
  http.post('*/v1/matches', async ({ request }) => {
    await delay(400)
    const body = (await readJson(request)) as components['schemas']['MatchCreate']
    const opponent = body.opponent_user_id
      ? (mockPlayers.find((p) => p.id === body.opponent_user_id) ?? null)
      : null
    return HttpResponse.json(
      matchResponse({
        creatorUsername: mockSession.data.user.username,
        opponent,
        bestOf: body.best_of,
        rated: body.rated,
      }),
      { status: 201 },
    )
  }),
  ...RBAC_PATHS.flatMap((path) => [
    http.get(path, rbacHandler),
    http.post(path, rbacHandler),
    http.patch(path, rbacHandler),
    http.put(path, rbacHandler),
    http.delete(path, rbacHandler),
  ]),
]
