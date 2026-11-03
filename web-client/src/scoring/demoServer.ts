import { useSyncExternalStore } from 'react'
import { ApiError, ApiUnreachable } from '../api/errors'
import { applyEdit, forgetRecords, readBoard, storageKey, writeBoard, type Board, type Change } from './scratchpad'

// Stands in for the API's match routes until they exist. It keeps its own
// board per match, apart from the device's scratchpad, and takes the
// device's changes one at a time. Each call waits and may fail the way the
// chosen network does, so syncing can be seen and tested. `offline` plays a
// browser that knows it's offline: each request fails at once, as fetch
// does then.

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

const NETWORK_KEY = 'fortymm-demo-network'

// Used only when localStorage throws.
let networkInMemory: Network = 'normal'
const networkListeners = new Set<() => void>()

// Kept in localStorage, so a reload stays `offline`.
export function demoNetwork(): Network {
  try {
    const stored = localStorage.getItem(NETWORK_KEY)
    return NETWORKS.find((network) => network === stored) ?? 'normal'
  } catch {
    return networkInMemory
  }
}

export function setDemoNetwork(network: Network): void {
  networkInMemory = network
  try {
    if (network === 'normal') localStorage.removeItem(NETWORK_KEY)
    else localStorage.setItem(NETWORK_KEY, network)
  } catch {
    // It stays in memory.
  }
  for (const listener of networkListeners) listener()
}

export function subscribeNetwork(listener: () => void): () => void {
  networkListeners.add(listener)
  return () => networkListeners.delete(listener)
}

export function useDemoNetwork(): Network {
  return useSyncExternalStore(subscribeNetwork, demoNetwork)
}

// Whether the browser knows it has no connection, so a request can't help.
// `navigator.onLine` can be true with nothing getting through, as on hall
// Wi-Fi with no internet, so a request can still fail.
export function knownOffline(): boolean {
  return demoNetwork() === 'offline' || !navigator.onLine
}

let sent = 0
// Moves on when the demo starts over, so a request still on its way can't
// bring back what was cleared.
let generation = 0

export function dropRequestsInFlight(): void {
  generation += 1
}

async function send<T>(request: string, work: () => T): Promise<T> {
  const behaviour = BEHAVIOUR[demoNetwork()]
  const started = generation
  await new Promise((resolve) => setTimeout(resolve, behaviour.latencyMs))
  if (generation !== started) {
    throw new ApiUnreachable(request, { cause: new Error('The demo started over') })
  }
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
export function sendChange(matchId: string, change: Change): Promise<void> {
  const request = `POST /v1/matches/${matchId}/changes`
  return send(request, () => {
    const board = applyEdit(readBoard(serverKey(matchId)), change.edit)
    if (!board) throw new ApiError(request, new Response(null, { status: 409 }))
    writeBoard(serverKey(matchId), board)
  })
}

// The server's board, with what every device has synced.
export function fetchBoard(matchId: string): Promise<Board> {
  return send(`GET /v1/matches/${matchId}/board`, () => readBoard(serverKey(matchId)))
}

// Starts the match over: its scratchpad, its outbox and the server's board.
export function resetMatch(matchId: string): void {
  dropRequestsInFlight()
  const keys = [storageKey(matchId), serverKey(matchId)]
  forgetRecords((key) => keys.includes(key))
}

// Deletes every demo match's scratchpad and server board, and sets the
// network back to normal.
export function clearEverything(): void {
  dropRequestsInFlight()
  const prefixes = [storageKey(''), serverKey('')]
  forgetRecords((key) => prefixes.some((prefix) => key.startsWith(prefix)))
  setDemoNetwork('normal')
}
