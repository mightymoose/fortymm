import { randomUUID } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import type { components } from '../src/api/schema.d.ts'
import { expect } from './fixtures.ts'

type MatchRequest = components['schemas']['MatchRequest']
type MatchDetailResponse = components['schemas']['MatchDetailResponse']
type MatchesResponse = components['schemas']['MatchesResponse']
type ErrorResponse = components['schemas']['ErrorsResponse']

// The real API's matches, as the specs make and read them with a phone's
// session.

export async function makeMatch(
  request: APIRequestContext,
  players: MatchRequest['players'],
  { rated, bestOf = 1 }: { rated: boolean; bestOf?: MatchRequest['best_of'] },
): Promise<MatchRequest> {
  const match: MatchRequest = { id: randomUUID(), best_of: bestOf, rated, players }
  const made = await request.post('/api/v1/matches', { data: match })
  expect(made.status(), `the API made the match: ${await made.text()}`).toBe(201)
  return match
}

export async function readMatch(request: APIRequestContext, id: string): Promise<MatchDetailResponse['data']> {
  return ((await (await request.get(`/api/v1/matches/${id}`)).json()) as MatchDetailResponse).data
}

// The match's state and games, such as `awaiting 11-5 11-7`.
export async function matchState(request: APIRequestContext, id: string): Promise<string> {
  const { state, games } = await readMatch(request, id)
  return [state.kind, ...games.map(([a, b]) => `${a}-${b}`)].join(' ')
}

// The ids of the newest matches with exactly `players`, side 0's first.
export async function matchesOf(request: APIRequestContext, players: readonly string[]): Promise<string[]> {
  const { data } = (await (await request.get('/api/v1/matches')).json()) as MatchesResponse
  return data
    .filter((match) => match.sides.map((side) => side.players[0].id).join() === players.join())
    .map((match) => match.id)
}

// Uploads a result link's envelope, base64url as the link holds it, to the
// match's approvals.
export async function uploadResult(request: APIRequestContext, matchId: string, envelope: string) {
  const response = await request.post(`/api/v1/matches/${matchId}/approvals`, {
    data: { envelope: Buffer.from(envelope, 'base64url').toString('hex') },
  })
  return { status: response.status(), body: (await response.json()) as ErrorResponse }
}
