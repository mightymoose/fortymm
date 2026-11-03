import { useEffect, useSyncExternalStore } from 'react'
import { ApiError, classifyFailure } from '../api/errors'
import { sendChange, type Network } from './demoServer'
import { markSent, pendingChanges, subscribe } from './scratchpad'

// Sends a match's outbox to the server in the background, oldest change
// first, one at a time, so the server applies them in the order they were
// made. A change the server can't take now waits, and the outbox tries again
// after a backoff or as soon as the browser is back online. A change it
// refuses for good (a 4xx) leaves the outbox, since sending it again can't
// help.

export type SyncStatus =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'waiting'; reason: 'offline' | 'failed' }

const RETRY_MS = [2000, 4000, 8000, 15000, 30000]

type Engine = {
  status: SyncStatus
  network: Network
  running: boolean
  failures: number
  retry: ReturnType<typeof setTimeout> | null
  users: number
  stop: () => void
}

const engines = new Map<string, Engine>()
const listeners = new Set<() => void>()
const IDLE: SyncStatus = { kind: 'idle' }

function setStatus(engine: Engine, status: SyncStatus): void {
  engine.status = status
  for (const listener of listeners) listener()
}

function retryable(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500 || error.status === 429
}

async function run(matchId: string, engine: Engine): Promise<void> {
  if (engine.running || engine.retry || engine.users === 0) return
  engine.running = true
  try {
    for (;;) {
      const [next] = pendingChanges(matchId)
      if (!next || engine.users === 0) {
        setStatus(engine, IDLE)
        return
      }
      setStatus(engine, { kind: 'sending' })
      try {
        await sendChange(matchId, next, engine.network)
        engine.failures = 0
        markSent(matchId, next.id)
      } catch (error) {
        if (!retryable(error)) {
          markSent(matchId, next.id)
          continue
        }
        const delay = RETRY_MS[Math.min(engine.failures, RETRY_MS.length - 1)]
        engine.failures += 1
        const reason = classifyFailure(error).kind === 'unreachable' ? 'offline' : 'failed'
        setStatus(engine, { kind: 'waiting', reason })
        engine.retry = setTimeout(() => {
          engine.retry = null
          void run(matchId, engine)
        }, delay)
        return
      }
    }
  } finally {
    engine.running = false
  }
}

// Sends now rather than at the next retry, as when the browser comes back
// online or a new change is queued.
function kick(matchId: string, engine: Engine): void {
  if (engine.retry) {
    clearTimeout(engine.retry)
    engine.retry = null
  }
  void run(matchId, engine)
}

function start(matchId: string, network: Network): () => void {
  let engine = engines.get(matchId)
  if (!engine) {
    const created: Engine = {
      status: IDLE,
      network,
      running: false,
      failures: 0,
      retry: null,
      users: 0,
      stop: () => {},
    }
    const online = () => kick(matchId, created)
    // A change saved here or in another tab. A waiting outbox keeps its
    // backoff, unless this is the first change it has.
    const unsubscribe = subscribe(() => {
      if (!created.running && !created.retry) void run(matchId, created)
    })
    window.addEventListener('online', online)
    created.stop = () => {
      unsubscribe()
      window.removeEventListener('online', online)
      if (created.retry) clearTimeout(created.retry)
      engines.delete(matchId)
    }
    engines.set(matchId, created)
    engine = created
  }
  const current = engine
  current.network = network
  current.users += 1
  kick(matchId, current)
  return () => {
    current.users -= 1
    if (current.users === 0) current.stop()
  }
}

// Syncs the match's outbox while the calling component is mounted, through
// `network`, and returns where the sync stands.
export function useSync(matchId: string, network: Network): SyncStatus {
  useEffect(() => start(matchId, network), [matchId, network])
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => engines.get(matchId)?.status ?? IDLE,
  )
}
