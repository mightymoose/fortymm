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
 * session and csrf cookies into a brand-new request context.
 *
 * A second `GET /v1/session` then resolves the fresh cookie and stamps the
 * row's `last_seen_at`: since #1438 the mint itself deliberately does not
 * stamp, and an unstamped (never-active) user is invisible to every public
 * listing — including the opponent search `findUserId` resolves ids through.
 * A seeded guest models a visitor who loaded the site and browsed, so it
 * browses once here (the api-side twin of this decision is
 * `api/tests/_helpers.py:start_session`). */
export async function mintGuest(baseURL: string): Promise<Guest> {
  const guest = await guestFromContext(await request.newContext({ baseURL }))
  const stamped = await guest.ctx.get(`${API}/session`)
  if (!stamped.ok()) {
    throw new Error(
      `session restamp failed: ${stamped.status()} ${await stamped.text()}`,
    )
  }
  return guest
}

/** Resolve a user's id via the opponent typeahead. Seeded guests are
 * searchable (`mintGuest` stamps them; tombstoned/merged and never-active
 * users are excluded), so this is how one guest names another as an opponent
 * without any claim/sign-in step. */
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

/** Create a two-party match with `creator` on side 1 and `opponentId` on side 2.
 *
 * **Unrated by default** — that keeps the guests out of the rating system, which
 * is what the conflict path wants (it is independent of rating). Pass
 * `{ rated: true }` when the *point* is the rating: only a rated two-human match
 * writes `rating_history`, and only a player with rating history has a chart to
 * draw (see `playRatedMatch`). Returns the new match id. */
export async function createMatch(
  creator: Guest,
  opponentId: string,
  bestOf: number,
  options: { rated?: boolean } = {},
): Promise<string> {
  const res = await creator.ctx.post(`${API}/matches`, {
    headers: { [CSRF_HEADER]: creator.csrf },
    data: {
      opponent_user_id: opponentId,
      best_of: bestOf,
      rated: options.rated ?? false,
    },
  })
  if (res.status() !== 201) {
    throw new Error(`create match failed: ${res.status()} ${await res.text()}`)
  }
  return ((await res.json()) as { id: string }).id
}

/** One game of a proposed board. */
export interface ResultGame {
  readonly game_number: number
  readonly side_1_points: number
  readonly side_2_points: number
}

/** Propose a result (`POST .../results`) — the first verb of the propose/accept
 * negotiation. The proposed board becomes the canonical game snapshot; on a
 * **rated** two-human match the result stays *standing* until the opposing side
 * accepts. Returns the standing result's id, which is the concurrency token the
 * acceptance must name. */
export async function proposeResult(
  proposer: Guest,
  matchId: string,
  games: ReadonlyArray<ResultGame>,
): Promise<string> {
  const res = await proposer.ctx.post(`${API}/matches/${matchId}/results`, {
    headers: { [CSRF_HEADER]: proposer.csrf },
    data: { games },
  })
  if (res.status() !== 201) {
    throw new Error(`propose result failed: ${res.status()} ${await res.text()}`)
  }
  return standingResultId(await res.json())
}

/** Complete an **unrated** match in one POST: on an unrated match the proposed
 * result self-accepts (no standing result is left for the other side), so this
 * is the whole finalize funnel — the same 201 the score-entry UI's "Finalize
 * result" rides. The tournament-scheduling spec uses it to finish a
 * materialized tournament match over the API, which is what triggers the
 * worker's `match_completed` re-solve. Unlike `proposeResult`, it deliberately
 * does NOT read a standing-result id — there is none on the self-accept path. */
export async function completeUnratedMatch(
  proposer: Guest,
  matchId: string,
  games: ReadonlyArray<ResultGame>,
): Promise<void> {
  const res = await proposer.ctx.post(`${API}/matches/${matchId}/results`, {
    headers: { [CSRF_HEADER]: proposer.csrf },
    data: { games },
  })
  if (res.status() !== 201) {
    throw new Error(`complete match failed: ${res.status()} ${await res.text()}`)
  }
}

/** Accept a standing proposal (`POST .../results/{id}/acceptance`) — the second
 * verb. Only the **opposing** side may accept (the proposer already consented by
 * proposing). This is what completes the match and, on a rated one, runs the
 * rating update: the two players' `rating_history` rows are written here. */
export async function acceptResult(
  acceptor: Guest,
  matchId: string,
  resultId: string,
): Promise<void> {
  const res = await acceptor.ctx.post(
    `${API}/matches/${matchId}/results/${resultId}/acceptance`,
    { headers: { [CSRF_HEADER]: acceptor.csrf } },
  )
  if (res.status() !== 201) {
    throw new Error(`accept result failed: ${res.status()} ${await res.text()}`)
  }
}

/**
 * Play a whole **rated** match to completion: `winner` beats `loser` 11–5 in a
 * best-of-1, and `loser` accepts the result.
 *
 * The seed behind any spec that needs a player with a *rating chart to draw*.
 * Every user is seeded an `initial` rating-history row when they join the default
 * league, so a brand-new guest already has one point on their timeline — but only
 * a decided **rated** match adds a second, which is what makes the window's net
 * change a real number rather than zero.
 *
 * Both sides come out rated (a rating update writes a row for each), so either
 * player's profile is a usable subject. Returns the match id.
 */
export async function playRatedMatch(
  winner: Guest,
  loser: Guest,
  loserId: string,
): Promise<string> {
  const matchId = await createMatch(winner, loserId, 1, { rated: true })
  const resultId = await proposeResult(winner, matchId, [
    { game_number: 1, side_1_points: 11, side_2_points: 5 },
  ])
  await acceptResult(loser, matchId, resultId)
  return matchId
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

function standingResultId(details: unknown): string {
  const negotiation = (
    details as {
      negotiation?: { standing_result?: { id?: string } | null }
    }
  ).negotiation
  const id = negotiation?.standing_result?.id
  if (id == null) {
    // A rated two-human match must leave the result standing for the opposing
    // side. If it self-accepted, the match wasn't rated (or wasn't two-party) —
    // fail loudly rather than seeding a match with no rating update.
    throw new Error(
      'no standing result on the proposed match — was it created with { rated: true }?',
    )
  }
  return id
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

/** First write of a game's score, returning the **raw** response — for a spec whose
 * subject is the refusal (a 422 on an out-of-order game), where `createGameScore`'s
 * throw-on-anything-but-201 is the wrong shape. */
export async function createGameScoreRaw(
  writer: Guest,
  matchId: string,
  gameNumber: number,
  side1: number,
  side2: number,
): Promise<APIResponse> {
  return writer.ctx.post(
    `${API}/matches/${matchId}/games/${gameNumber}/scores/new`,
    {
      headers: { [CSRF_HEADER]: writer.csrf },
      data: { side_1_points: side1, side_2_points: side2 },
    },
  )
}

/** Clear a game's committed score (`DELETE .../scores`), returning the raw response
 * so a spec can assert the status — a 200 on the last game, or the refusal on any
 * earlier one. */
export async function deleteGameScore(
  writer: Guest,
  matchId: string,
  gameNumber: number,
): Promise<APIResponse> {
  return writer.ctx.delete(
    `${API}/matches/${matchId}/games/${gameNumber}/scores`,
    { headers: { [CSRF_HEADER]: writer.csrf } },
  )
}
