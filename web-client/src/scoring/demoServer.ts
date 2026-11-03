import { queryOptions } from '@tanstack/react-query'
import { ApiError, ApiUnreachable } from '../api/errors'
import type { GamePoints } from './board'
import { demoMatch, type Match, type MatchPlayer } from './demoMatches'
import { clearGame, reopen, saveGame, submitResult, type Scorer, type Submission } from './scratchpad'

// Stands in for the API's match routes until they exist. Each call waits and
// may fail the way the chosen network does, so the page's loading, saving and
// failure states can be seen and tested. The page picks the network from its
// `network` search param, such as `?network=flaky`.

export const NETWORKS = ['normal', 'slow', 'flaky', 'offline', 'broken'] as const
export type Network = (typeof NETWORKS)[number]

type Failure = 'unreachable' | number

// `fails` gets the count of requests sent so far, so `flaky` fails every
// second one and a test can tell which.
const BEHAVIOUR: Record<Network, { latencyMs: number; fails: (count: number) => Failure | null }> = {
  normal: { latencyMs: 300, fails: () => null },
  slow: { latencyMs: 2500, fails: () => null },
  flaky: { latencyMs: 800, fails: (count) => (count % 2 === 1 ? 503 : null) },
  offline: { latencyMs: 1000, fails: () => 'unreachable' },
  broken: { latencyMs: 400, fails: () => 500 },
}

export function parseNetwork(value: unknown): Network {
  return NETWORKS.find((network) => network === value) ?? 'normal'
}

let sent = 0

async function send<T>(request: string, network: Network, work: () => T): Promise<T> {
  const behaviour = BEHAVIOUR[network]
  await new Promise((resolve) => setTimeout(resolve, behaviour.latencyMs))
  const failure = behaviour.fails(sent++)
  if (failure === 'unreachable') {
    throw new ApiUnreachable(request, { cause: new TypeError('Failed to fetch') })
  }
  if (failure !== null) throw new ApiError(request, new Response(null, { status: failure }))
  return work()
}

// The store refuses a game write once the result is submitted. The API will
// answer that with a 409.
function frozenUnless(request: string, written: boolean): void {
  if (!written) throw new ApiError(request, new Response(null, { status: 409 }))
}

export function fetchMatch(id: string, self: MatchPlayer, network: Network): Promise<Match> {
  return send(`GET /v1/matches/${id}`, network, () => demoMatch(id, self))
}

export function putGame(
  matchId: string,
  game: number,
  points: GamePoints,
  savedBy: Scorer,
  network: Network,
): Promise<void> {
  const request = `PUT /v1/matches/${matchId}/games/${game}`
  return send(request, network, () => frozenUnless(request, saveGame(matchId, game, points, savedBy)))
}

export function deleteGame(matchId: string, game: number, network: Network): Promise<void> {
  const request = `DELETE /v1/matches/${matchId}/games/${game}`
  return send(request, network, () => frozenUnless(request, clearGame(matchId, game)))
}

export function postResult(
  matchId: string,
  submission: Omit<Extract<Submission, { phase: 'submitted' }>, 'phase' | 'submittedAt'>,
  network: Network,
): Promise<void> {
  return send(`POST /v1/matches/${matchId}/result`, network, () => {
    submitResult(matchId, submission)
  })
}

export function deleteResult(matchId: string, network: Network): Promise<void> {
  return send(`DELETE /v1/matches/${matchId}/result`, network, () => {
    reopen(matchId)
  })
}

// The network isn't part of the key: a connection that drops or comes back
// doesn't make the match another one.
export function matchQuery(id: string, self: MatchPlayer, network: Network) {
  return queryOptions({
    queryKey: ['demo-match', id, self.id],
    queryFn: () => fetchMatch(id, self, network),
    staleTime: Infinity,
  })
}
