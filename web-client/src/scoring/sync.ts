import { useEffect, useRef, useSyncExternalStore } from 'react'
import { ApiError, classifyFailure } from '../api/errors'
import { fetchBoard, knownOffline, sendChange, type Network } from './demoServer'
import { markSent, matchesWithChanges, pendingChanges, receiveBoard, subscribe, type Change } from './scratchpad'

// Sends a match's outbox to the server in the background, oldest change
// first, one at a time, so the server applies them in the order they were
// made. While the browser knows it's offline, nothing is sent until it fires
// `online`. A change the server can't take now waits, and the outbox tries
// again after a backoff or as soon as the browser is back online. A change it
// refuses for good (a 4xx) leaves the outbox, since sending it again can't
// help. Once the outbox is empty, it pulls the server's board, so the page
// shows what other devices synced. It pulls after sending, never during, so
// the board it gets has every change this device sent. A pull that fails
// leaves the device's board as it is, and the next sync pulls again.

// Two separate facts about a match's sync. A stuck outbox that is trying
// again is both stuck and sending.
export type SyncStatus = {
  // The change on its way to the server now, if any.
  sending: Change | null
  // Pulling the server's board now.
  pulling: boolean
  // Why the last send didn't get through, until one does.
  stuck: 'offline' | 'failed' | null
}

const RETRY_MS = [2000, 4000, 8000, 15000, 30000]

type Engine = {
  status: SyncStatus
  network: Network
  running: boolean
  failures: number
  retry: ReturnType<typeof setTimeout> | null
  // The server's board may have changed since the last pull.
  pull: boolean
  users: number
  stop: () => void
}

const engines = new Map<string, Engine>()
const listeners = new Set<() => void>()
const IDLE: SyncStatus = { sending: null, pulling: false, stuck: null }

function setStatus(engine: Engine, status: Partial<SyncStatus>): void {
  engine.status = { ...engine.status, ...status }
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
      if (engine.users === 0) return
      if (!next) {
        // Nothing left to send, so nothing is stuck.
        setStatus(engine, { stuck: null })
        if (engine.pull && !knownOffline(engine.network)) {
          setStatus(engine, { pulling: true })
          try {
            receiveBoard(matchId, await fetchBoard(matchId, engine.network))
            engine.pull = false
          } catch {
            // The device's board stands until the next pull.
          } finally {
            setStatus(engine, { pulling: false })
          }
        }
        return
      }
      // Sending can't work, so it waits for the browser's `online` event,
      // with no retry timer.
      if (knownOffline(engine.network)) {
        setStatus(engine, { stuck: 'offline' })
        return
      }
      setStatus(engine, { sending: next })
      try {
        await sendChange(matchId, next, engine.network)
        engine.failures = 0
        engine.pull = true
        setStatus(engine, { sending: null, stuck: null })
        markSent(matchId, next.id)
      } catch (error) {
        if (!retryable(error)) {
          setStatus(engine, { sending: null })
          markSent(matchId, next.id)
          continue
        }
        const delay = RETRY_MS[Math.min(engine.failures, RETRY_MS.length - 1)]
        engine.failures += 1
        const reason = classifyFailure(error).kind === 'unreachable' ? 'offline' : 'failed'
        setStatus(engine, { sending: null, stuck: reason })
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

// Syncs now rather than at the next retry, as when the browser comes back
// online or the page opens, and pulls the server's board.
function kick(matchId: string, engine: Engine): void {
  engine.pull = true
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
      pull: true,
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

// Syncs every match that has unsent changes, whichever page is open, until
// its outbox is empty. Root runs it, so a score saved with no signal syncs
// once the device is back online, even after the scoring page has closed.
export function useAppSync(network: Network): void {
  const pending = useSyncExternalStore(subscribe, matchesWithChanges)
  const running = useRef(new Map<string, () => void>())
  useEffect(() => {
    const ids = new Set(pending === '' ? [] : pending.split(' '))
    for (const [id, stop] of running.current) {
      if (!ids.has(id)) {
        stop()
        running.current.delete(id)
      }
    }
    for (const id of ids) {
      if (!running.current.has(id)) running.current.set(id, start(id, network))
    }
  }, [pending, network])
  // A new network restarts every sync, which sends at once.
  useEffect(() => {
    const syncs = running.current
    return () => {
      for (const stop of syncs.values()) stop()
      syncs.clear()
    }
  }, [network])
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
