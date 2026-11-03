import { useSyncExternalStore } from 'react'
import { ApiError, ApiUnreachable } from '../api/errors'
import { forgetBoards } from './boards'

// Stands in for the API's match routes until they exist. It keeps the
// latest board per match, the fragment's text, so spectators and
// tournament directors can watch a match. Each call waits and may fail the
// way the chosen network does, so syncing can be seen and tested.
// `offline` plays a browser that knows it's offline: each request fails at
// once, as fetch does then.

export const NETWORKS = ['normal', 'slow', 'flaky', 'offline', 'broken'] as const
export type Network = (typeof NETWORKS)[number]

type Failure = 'unreachable' | number

// `fails` gets the count of requests sent on this network so far, so
// `flaky` fails every second one.
const BEHAVIOUR: Record<Network, { latencyMs: number; fails: (count: number) => Failure | null }> = {
  normal: { latencyMs: 300, fails: () => null },
  slow: { latencyMs: 2500, fails: () => null },
  flaky: { latencyMs: 300, fails: (count) => (count % 2 === 1 ? 503 : null) },
  offline: { latencyMs: 0, fails: () => 'unreachable' },
  broken: { latencyMs: 400, fails: () => 500 },
}

const NETWORK_KEY = 'fortymm-demo-network'

// Used only when localStorage throws.
let networkInMemory: Network = 'normal'
const networkListeners = new Set<() => void>()
let sent = 0

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
  sent = 0
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

const PREFIX = 'fortymm-demo-server:'
// Used only when localStorage throws.
const boardsInMemory = new Map<string, string>()

// The board every device synced last, or null when none has.
export function serverBoard(matchId: string): string | null {
  try {
    return localStorage.getItem(PREFIX + matchId)
  } catch {
    return boardsInMemory.get(matchId) ?? null
  }
}

export function setServerBoard(matchId: string, text: string): void {
  try {
    localStorage.setItem(PREFIX + matchId, text)
  } catch {
    boardsInMemory.set(matchId, text)
  }
}

export function putBoard(matchId: string, text: string): Promise<void> {
  return send(`PUT /v1/matches/${matchId}/board`, () => setServerBoard(matchId, text))
}

export function fetchBoard(matchId: string): Promise<string | null> {
  return send(`GET /v1/matches/${matchId}/board`, () => serverBoard(matchId))
}

function removeServerBoards(keep: (matchId: string) => boolean): void {
  for (const matchId of [...boardsInMemory.keys()]) if (!keep(matchId)) boardsInMemory.delete(matchId)
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX) && !keep(key.slice(PREFIX.length))) localStorage.removeItem(key)
    }
  } catch {
    // Nothing was stored there.
  }
}

// Starts the match over: the server's board and this tab's unsent one.
export function resetMatch(matchId: string): void {
  dropRequestsInFlight()
  removeServerBoards((id) => id !== matchId)
  forgetBoards(matchId)
}

// Deletes every demo match's board, and sets the network back to normal.
export function clearEverything(): void {
  dropRequestsInFlight()
  removeServerBoards(() => false)
  forgetBoards()
  setDemoNetwork('normal')
}
