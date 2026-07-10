import { APIRequestContext, APIResponse, request } from '@playwright/test'

// Composed-stack API helpers for provisioning a *two-party* match directly
// against the real API (through nginx at `/api`), bypassing the UI. The
// 409 score-conflict flow (issue #873) is structurally unreachable on a solo
// match — a version conflict needs two distinct participants writing the same
// game — so a spec that drives it has to mint two real players and a shared
// match. Doing that over the API keeps the browser side focused on the one
// surface under test (the conflict notice + "Replace with my score"), with a
// single deterministic browser context.
//
// Mutations ride the double-submit CSRF defense (`app/main.py`): once a
// `session` cookie is present, any unsafe method must echo the non-HttpOnly
// `csrf_token` cookie back in the `x-csrf-token` header. Each guest carries the
// token it was issued so its writes are accepted.

const API = '/api/v1'
const CSRF_COOKIE = 'csrf_token'
const CSRF_HEADER = 'x-csrf-token'

/** A provisioned guest: its own cookie jar (session + csrf) plus the identity
 * fields a spec needs to wire up and assert against a match. */
export interface Guest {
  /** Request context holding this guest's `session`/`csrf_token` cookies. */
  readonly ctx: APIRequestContext
  /** The auto-assigned display username (also this guest's search key). */
  readonly username: string
  /** The CSRF token to echo in the header on this guest's writes. */
  readonly csrf: string
}

async function csrfToken(ctx: APIRequestContext): Promise<string> {
  const { cookies } = await ctx.storageState()
  const cookie = cookies.find((c) => c.name === CSRF_COOKIE)
  if (!cookie) throw new Error('no csrf_token cookie issued for this session')
  return cookie.value
}

/** Build a Guest from an already-authenticated request context: reads its
 * username (`GET /v1/session`) and the CSRF token it was issued. Shared by
 * `mintGuest` (a fresh context) and specs that adopt the browser's own
 * `page.request` context, so page navigations run as that guest. */
export async function guestFromContext(ctx: APIRequestContext): Promise<Guest> {
  const res = await ctx.get(`${API}/session`)
  if (!res.ok()) {
    throw new Error(`session mint failed: ${res.status()} ${await res.text()}`)
  }
  return {
    ctx,
    username: usernameFrom(await res.json()),
    csrf: await csrfToken(ctx),
  }
}

/** Mint a fresh ephemeral guest: `GET /v1/session` creates a User + issues the
 * session and csrf cookies into a brand-new request context. */
export async function mintGuest(baseURL: string): Promise<Guest> {
  return guestFromContext(await request.newContext({ baseURL }))
}

/** Resolve a user's id via the opponent typeahead. Ephemeral guests are
 * searchable (only tombstoned/merged users are excluded), so this is how one
 * guest names another as an opponent without any claim/sign-in step. */
export async function findUserId(
  searcher: Guest,
  username: string,
): Promise<string> {
  const res = await searcher.ctx.get(`${API}/players/search`, {
    params: { q: username },
  })
  if (!res.ok()) {
    throw new Error(`player search failed: ${res.status()} ${await res.text()}`)
  }
  const players = (await res.json()) as ReadonlyArray<{
    id: string
    username: string
  }>
  const match = players.find((p) => p.username === username)
  if (!match) throw new Error(`player "${username}" not found in search`)
  return match.id
}

/** Create an unrated two-party match with `creator` on side 1 and `opponentId`
 * on side 2. Unrated keeps the guests out of the rating system; the conflict
 * path is independent of rating. Returns the new match id. */
export async function createMatch(
  creator: Guest,
  opponentId: string,
  bestOf: number,
): Promise<string> {
  const res = await creator.ctx.post(`${API}/matches`, {
    headers: { [CSRF_HEADER]: creator.csrf },
    data: { opponent_user_id: opponentId, best_of: bestOf, rated: false },
  })
  if (res.status() !== 201) {
    throw new Error(`create match failed: ${res.status()} ${await res.text()}`)
  }
  return ((await res.json()) as { id: string }).id
}

/** First write of a game's score (`POST .../scores/new`) — needs no version
 * token (the unique constraint asserts no prior score). Returns the committed
 * version so a later conditional edit can target it. */
export async function createGameScore(
  writer: Guest,
  matchId: string,
  gameNumber: number,
  side1: number,
  side2: number,
): Promise<number> {
  const res = await writer.ctx.post(
    `${API}/matches/${matchId}/games/${gameNumber}/scores/new`,
    {
      headers: { [CSRF_HEADER]: writer.csrf },
      data: { side_1_points: side1, side_2_points: side2 },
    },
  )
  if (res.status() !== 201) {
    throw new Error(`create score failed: ${res.status()} ${await res.text()}`)
  }
  return versionOf(await res.json(), gameNumber)
}

/** Conditional edit of a game's score (`PUT .../scores`). The write applies
 * only if the committed row is still at `expectedVersion`; otherwise the server
 * returns 409 carrying the committed score. Returns the raw response so the
 * caller can assert on its status. */
export async function editGameScore(
  writer: Guest,
  matchId: string,
  gameNumber: number,
  side1: number,
  side2: number,
  expectedVersion: number,
): Promise<APIResponse> {
  return writer.ctx.put(
    `${API}/matches/${matchId}/games/${gameNumber}/scores`,
    {
      headers: { [CSRF_HEADER]: writer.csrf },
      data: {
        side_1_points: side1,
        side_2_points: side2,
        expected_version: expectedVersion,
      },
    },
  )
}

function usernameFrom(sessionJson: unknown): string {
  return (sessionJson as { data: { user: { username: string } } }).data.user
    .username
}

function versionOf(details: unknown, gameNumber: number): number {
  const games = (details as { games?: ReadonlyArray<Record<string, unknown>> })
    .games
  const game = games?.find((g) => g.game_number === gameNumber)
  const score = game?.score as { version?: number } | undefined
  if (score?.version == null) {
    throw new Error(`no committed score/version for game ${gameNumber}`)
  }
  return score.version
}
