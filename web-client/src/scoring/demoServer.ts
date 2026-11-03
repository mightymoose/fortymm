import { ApiError, ApiUnreachable } from '../api/errors'
import { applyChange, forgetRecords, readBoard, storageKey, writeBoard, type Board, type Change } from './scratchpad'

// Stands in for the API's match routes until they exist. It keeps its own
// board per match, apart from the scratchpad on the device, and takes the
// device's changes one at a time. Each call waits and may fail the way the
// chosen network does, so the page's syncing can be seen and tested. The page picks the network from its `network` search param, such
// as `?network=flaky`. `offline` plays a browser that knows it's offline:
// each request fails at once, as fetch does then.

export const NETWORKS = ['normal', 'slow', 'flaky', 'offline', 'broken'] as const
export type Network = (typeof NETWORKS)[number]

type Failure = 'unreachable' | number

// `fails` gets the count of requests sent so far, so `flaky` fails every
// second one.
const BEHAVIOUR: Record<Network, { latencyMs: number; fails: (count: number) => Failure | null }> = {
  normal: { latencyMs: 300, fails: () => null },
  slow: { latencyMs: 2500, fails: () => null },
  flaky: { latencyMs: 800, fails: (count) => (count % 2 === 1 ? 503 : null) },
  offline: { latencyMs: 0, fails: () => 'unreachable' },
  broken: { latencyMs: 400, fails: () => 500 },
}

export function parseNetwork(value: unknown): Network {
  return NETWORKS.find((network) => network === value) ?? 'normal'
}

// Whether the browser knows it has no connection, so a request can't help.
// `offline` plays that. `navigator.onLine` can be true with nothing getting
// through, as on hall Wi-Fi with no internet, so a request can still fail.
export function knownOffline(network: Network): boolean {
  return network === 'offline' || !navigator.onLine
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

// The server's board, with what every device has synced.
export function fetchBoard(matchId: string, network: Network): Promise<Board> {
  return send(`GET /v1/matches/${matchId}/board`, network, () => readBoard(serverKey(matchId)))
}

// Starts the match over: its scratchpad, its outbox and the server's board.
export function resetMatch(matchId: string): void {
  const keys = [storageKey(matchId), serverKey(matchId)]
  forgetRecords((key) => keys.includes(key))
}

// Deletes every demo match's scratchpad and server board.
export function clearEverything(): void {
  const prefixes = [storageKey(''), serverKey('')]
  forgetRecords((key) => prefixes.some((prefix) => key.startsWith(prefix)))
}
