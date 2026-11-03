import { queryOptions } from '@tanstack/react-query'
import { ApiError, ApiUnreachable, classifyFailure } from '../api/errors'
import { demoMatch, type Match, type MatchPlayer } from './demoMatches'
import { applyChange, readBoard, writeBoard, type Change } from './scratchpad'

// Stands in for the API's match routes until they exist. It keeps its own
// board per match, apart from the scratchpad on the device, and takes the
// device's changes one at a time. Each call waits and may fail the way the
// chosen network does, so the page's loading and syncing can be seen and
// tested. The page picks the network from its `network` search param, such
// as `?network=flaky`.

export const NETWORKS = ['normal', 'slow', 'flaky', 'offline', 'broken'] as const
export type Network = (typeof NETWORKS)[number]

type Failure = 'unreachable' | number

// `fails` gets the count of requests sent so far, so `flaky` fails every
// second one.
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

export function serverKey(matchId: string): string {
  return `fortymm-demo-server:${matchId}`
}

// Applies one change to the server's board. A game write after the result
// was submitted answers 409, as the API will.
export function sendChange(matchId: string, change: Change, network: Network): Promise<void> {
  const request = `POST /v1/matches/${matchId}/changes`
  return send(request, network, () => {
    const board = applyChange(readBoard(serverKey(matchId)), change)
    if (!board) throw new ApiError(request, new Response(null, { status: 409 }))
    writeBoard(serverKey(matchId), board)
  })
}

function matchKey(id: string): string {
  return `fortymm-match:${id}`
}

// The match as the last load got it, so the page opens with no signal.
function savedMatch(id: string): Match | null {
  try {
    const raw = localStorage.getItem(matchKey(id))
    return raw === null ? null : (JSON.parse(raw) as Match)
  } catch {
    return null
  }
}

function saveMatch(match: Match): void {
  try {
    localStorage.setItem(matchKey(match.id), JSON.stringify(match))
  } catch {
    // The page still works online without it.
  }
}

// Loads the match, or the saved copy when the server can't be reached.
export function matchQuery(id: string, self: MatchPlayer, network: Network) {
  return queryOptions({
    // The network isn't part of the key: a connection that drops or comes
    // back doesn't make the match another one.
    queryKey: ['demo-match', id, self.id],
    queryFn: async () => {
      try {
        const match = await send(`GET /v1/matches/${id}`, network, () => demoMatch(id, self))
        saveMatch(match)
        return match
      } catch (error) {
        const saved = savedMatch(id)
        if (saved && classifyFailure(error).kind === 'unreachable') return saved
        throw error
      }
    },
    staleTime: Infinity,
  })
}
