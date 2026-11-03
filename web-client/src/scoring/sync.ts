import { useEffect, useRef, useSyncExternalStore } from 'react'
import { ApiError, classifyFailure } from '../api/errors'
import { fetchBoard, knownOffline, sendChange, subscribeNetwork } from './demoServer'
import { markSent, matchesWithChanges, pendingChanges, receiveBoard, subscribe, type Change } from './scratchpad'

// Sends a match's outbox to the server in the background, oldest change
// first, one at a time, so the server applies them in the order they were
// made. While the browser knows it's offline, it sends nothing until the
// browser fires `online`. A change the server can't take now waits, with a
// backoff, or until `online`. A change it refuses for good (a 4xx other
// than 429) leaves the outbox, since sending it again can't help. Once the
// outbox is empty, it pulls the server's board, never sooner, so the board
// it gets has every change this device sent.

// Two separate facts about a match's sync. A stuck outbox that is trying
// again is both stuck and sending.
export type SyncStatus = {
  sending: Change | null
  pulling: boolean
  // Why the last send didn't get through, until one does.
  stuck: 'offline' | 'failed' | null
}

const RETRY_MS = [2000, 4000, 8000, 15000, 30000]

const IDLE: SyncStatus = { sending: null, pulling: false, stuck: null }

type State =
  | { kind: 'idle' }
  | { kind: 'sending'; change: Change }
  | { kind: 'waitingRetry'; timer: ReturnType<typeof setTimeout> }
  | { kind: 'waitingOnline' }
  | { kind: 'pulling' }
  | { kind: 'stopped' }

const statusListeners = new Set<() => void>()

function retryable(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500 || error.status === 429
}

class MatchSync {
  status: SyncStatus = IDLE
  holders = 0
  private state: State = { kind: 'idle' }
  private stuck: SyncStatus['stuck'] = null
  private failures = 0
  // The server's board may have changed since the last pull.
  private needsPull = true
  private readonly unsubscribe: () => void
  private readonly unsubscribeNetwork: () => void
  private readonly matchId: string

  constructor(matchId: string) {
    this.matchId = matchId
    // A change saved here or in another tab. A waiting retry keeps its
    // backoff.
    this.unsubscribe = subscribe(() => {
      if (this.state.kind === 'idle' || this.state.kind === 'waitingOnline') void this.step()
    })
    window.addEventListener('online', this.kick)
    // A switch of the demo network plays a connection that came back, so a
    // waiting outbox sends at once rather than at its next retry.
    this.unsubscribeNetwork = subscribeNetwork(() => {
      if (!knownOffline()) this.kick()
    })
  }

  // Syncs now rather than at the next retry, and pulls the server's board,
  // as when the browser comes back online or the page opens.
  readonly kick = (): void => {
    this.needsPull = true
    if (this.state.kind === 'waitingRetry') clearTimeout(this.state.timer)
    if (this.state.kind === 'waitingRetry' || this.state.kind === 'waitingOnline') this.enter({ kind: 'idle' })
    void this.step()
  }

  stop(): void {
    if (this.state.kind === 'waitingRetry') clearTimeout(this.state.timer)
    this.state = { kind: 'stopped' }
    this.unsubscribe()
    this.unsubscribeNetwork()
    window.removeEventListener('online', this.kick)
  }

  // Whether `state` is still the one, after an await. Anything else, such
  // as a stop, means its answer changes nothing.
  private isIn(state: State): boolean {
    return this.state === state
  }

  private enter(state: State): void {
    this.state = state
    this.status = {
      sending: state.kind === 'sending' ? state.change : null,
      pulling: state.kind === 'pulling',
      stuck: this.stuck,
    }
    for (const listener of statusListeners) listener()
  }

  private async step(): Promise<void> {
    if (this.state.kind !== 'idle') return
    const [next] = pendingChanges(this.matchId)
    if (!next) {
      this.stuck = null
      if (this.needsPull && !knownOffline()) await this.pull()
      else this.enter({ kind: 'idle' })
      return
    }
    if (knownOffline()) {
      this.stuck = 'offline'
      this.enter({ kind: 'waitingOnline' })
      return
    }
    const sending: State = { kind: 'sending', change: next }
    this.enter(sending)
    try {
      await sendChange(this.matchId, next)
    } catch (error) {
      if (!this.isIn(sending)) return
      if (retryable(error)) {
        const delay = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)]
        this.failures += 1
        this.stuck = classifyFailure(error).kind === 'unreachable' ? 'offline' : 'failed'
        this.enter({
          kind: 'waitingRetry',
          timer: setTimeout(() => {
            this.enter({ kind: 'idle' })
            void this.step()
          }, delay),
        })
        return
      }
      this.enter({ kind: 'idle' })
      markSent(this.matchId, next.id)
      void this.step()
      return
    }
    if (!this.isIn(sending)) return
    this.failures = 0
    this.stuck = null
    this.needsPull = true
    this.enter({ kind: 'idle' })
    markSent(this.matchId, next.id)
    void this.step()
  }

  private async pull(): Promise<void> {
    const pulling: State = { kind: 'pulling' }
    this.enter(pulling)
    try {
      const board = await fetchBoard(this.matchId)
      if (!this.isIn(pulling)) return
      receiveBoard(this.matchId, board)
      this.needsPull = false
    } catch {
      // The device's board stands until the next pull.
    }
    if (!this.isIn(pulling)) return
    this.enter({ kind: 'idle' })
    // A change saved while it pulled. A pull that failed waits for the next
    // kick or change rather than trying again at once.
    if (pendingChanges(this.matchId).length > 0) void this.step()
  }
}

const syncs = new Map<string, MatchSync>()

// Syncs the match until the returned release is called. Root and the
// scoring page each hold a match, and its sync stops when the last lets go.
// A response that lands after that changes nothing.
function hold(matchId: string): () => void {
  let sync = syncs.get(matchId)
  if (!sync) {
    sync = new MatchSync(matchId)
    syncs.set(matchId, sync)
  }
  const held = sync
  held.holders += 1
  held.kick()
  return () => {
    held.holders -= 1
    if (held.holders > 0) return
    held.stop()
    syncs.delete(matchId)
  }
}

// Syncs every match that has unsent changes, whichever page is open. Root
// runs it, so a score saved with no signal syncs once the device is back
// online, even after the scoring page has closed.
export function useAppSync(): void {
  const pending = useSyncExternalStore(subscribe, matchesWithChanges)
  const held = useRef(new Map<string, () => void>())
  useEffect(() => {
    const ids = new Set(pending === '' ? [] : pending.split(' '))
    for (const [id, release] of held.current) {
      if (ids.has(id)) continue
      release()
      held.current.delete(id)
    }
    for (const id of ids) {
      if (!held.current.has(id)) held.current.set(id, hold(id))
    }
  }, [pending])
  useEffect(() => {
    const releases = held.current
    return () => {
      for (const release of releases.values()) release()
      releases.clear()
    }
  }, [])
}

// Syncs the match while the calling component is mounted, pulling the
// server's board even with nothing to send, and returns where it stands.
export function useSync(matchId: string): SyncStatus {
  useEffect(() => hold(matchId), [matchId])
  return useSyncExternalStore(
    (listener) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
    () => syncs.get(matchId)?.status ?? IDLE,
  )
}
