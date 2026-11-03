import { useEffect, useRef, useSyncExternalStore } from 'react'
import { ApiError, classifyFailure } from '../api/errors'
import { acknowledge, boardsOf, dropBoard, matchesWithPending, subscribeBoards } from './boards'
import { fetchBoard, knownOffline, putBoard, subscribeNetwork } from './demoServer'

// Sends a match's board to the server in the background, so spectators and
// tournament directors can watch it. It's best effort: the URL keeps the
// scores, and nothing waits on a send or fails with it. Only the newest
// board saved goes, one send at a time, so a late older copy from this tab
// can't land after a newer one. While the browser knows it's offline, it
// sends nothing until `online`. A board the server can't take now waits,
// with a backoff, or until `online`. One it refuses for good (a 4xx other
// than 429) is dropped. With nothing to send, a watching page pulls the
// server's board, never sooner, so it can't pull over a board of its own.

// Two separate facts about a match's sync. A stuck board that is trying
// again is both stuck and sending.
export type SyncStatus = {
  sending: boolean
  pulling: boolean
  // Why the last send didn't get through, until one does.
  stuck: 'offline' | 'failed' | null
}

const IDLE: SyncStatus = { sending: false, pulling: false, stuck: null }

const RETRY_MS = [2000, 4000, 8000, 15000, 30000]

// How often a watching page pulls while it's visible.
export const PULL_MS = 5000

export function retryDelay(failures: number): number {
  return RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]
}

export function retryable(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500 || error.status === 429
}

export type Step = 'send' | 'waitOnline' | 'pull' | 'rest'

// What an idle sync does next.
export function nextStep({
  pending,
  offline,
  wantsPull,
}: {
  pending: string | null
  offline: boolean
  wantsPull: boolean
}): Step {
  if (pending !== null) return offline ? 'waitOnline' : 'send'
  return wantsPull && !offline ? 'pull' : 'rest'
}

type State =
  | { kind: 'idle' }
  | { kind: 'sending'; board: string }
  | { kind: 'waitingRetry'; timer: ReturnType<typeof setTimeout> }
  | { kind: 'waitingOnline' }
  | { kind: 'pulling' }
  | { kind: 'stopped' }

export type OnBoard = (text: string) => void

const statusListeners = new Set<() => void>()

class MatchSync {
  status: SyncStatus = IDLE
  holders = 0
  // The pages that want the server's board, each told of every pull.
  readonly watchers = new Set<{ current: OnBoard }>()
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
    // A save, here or in another component. A waiting retry keeps its
    // backoff.
    this.unsubscribe = subscribeBoards(() => {
      if (this.state.kind === 'waitingOnline') this.enter({ kind: 'idle' })
      void this.step()
    })
    window.addEventListener('online', this.kick)
    // A switch of the demo network plays a connection that came back, so a
    // waiting board sends at once rather than at its next retry.
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

  // Pulls once it has nothing to send, without cutting a backoff short.
  pullSoon(): void {
    this.needsPull = true
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
      sending: state.kind === 'sending',
      pulling: state.kind === 'pulling',
      stuck: this.stuck,
    }
    for (const listener of statusListeners) listener()
  }

  private async step(): Promise<void> {
    if (this.state.kind !== 'idle') return
    const { pending } = boardsOf(this.matchId)
    const step = nextStep({
      pending,
      offline: knownOffline(),
      wantsPull: this.needsPull && this.watchers.size > 0,
    })
    switch (step) {
      case 'rest':
        if (pending === null) this.stuck = null
        this.enter({ kind: 'idle' })
        return
      case 'waitOnline':
        this.stuck = 'offline'
        this.enter({ kind: 'waitingOnline' })
        return
      case 'pull':
        this.stuck = null
        return this.pull()
      case 'send':
        return this.send(pending!)
    }
  }

  private async send(board: string): Promise<void> {
    const sending: State = { kind: 'sending', board }
    this.enter(sending)
    try {
      await putBoard(this.matchId, board)
    } catch (error) {
      if (!this.isIn(sending)) return
      if (retryable(error)) {
        const delay = retryDelay(this.failures)
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
      dropBoard(this.matchId, board)
      void this.step()
      return
    }
    if (!this.isIn(sending)) return
    this.failures = 0
    this.stuck = null
    this.needsPull = true
    this.enter({ kind: 'idle' })
    acknowledge(this.matchId, board)
    void this.step()
  }

  private async pull(): Promise<void> {
    const pulling: State = { kind: 'pulling' }
    this.enter(pulling)
    try {
      const board = await fetchBoard(this.matchId)
      if (!this.isIn(pulling)) return
      this.needsPull = false
      // A board saved while it pulled stands over the one it pulled.
      if (board !== null && boardsOf(this.matchId).pending === null) {
        for (const watcher of this.watchers) watcher.current(board)
      }
    } catch {
      // The board on screen stands until the next pull.
    }
    if (!this.isIn(pulling)) return
    this.enter({ kind: 'idle' })
    // A board saved while it pulled. A pull that failed waits for the next
    // poll rather than trying again at once.
    if (boardsOf(this.matchId).pending !== null) void this.step()
  }
}

const syncs = new Map<string, MatchSync>()

// Syncs the match until the returned release is called. Root and the
// scoring page each hold a match, and its sync stops when the last lets go.
// A response that lands after that changes nothing. A holder with a
// watcher also gets each board the sync pulls.
function hold(matchId: string, watcher?: { current: OnBoard }): { sync: MatchSync; release: () => void } {
  let sync = syncs.get(matchId)
  if (!sync) {
    sync = new MatchSync(matchId)
    syncs.set(matchId, sync)
  }
  const held = sync
  held.holders += 1
  if (watcher) held.watchers.add(watcher)
  held.kick()
  return {
    sync: held,
    release: () => {
      if (watcher) held.watchers.delete(watcher)
      held.holders -= 1
      if (held.holders > 0) return
      held.stop()
      syncs.delete(matchId)
    },
  }
}

// Syncs every match with a board to send, whichever page is open. Root runs
// it, so a board saved with no signal goes once the device is back online,
// even after the scoring page has closed.
export function useAppSync(): void {
  const pending = useSyncExternalStore(subscribeBoards, matchesWithPending)
  const held = useRef(new Map<string, () => void>())
  useEffect(() => {
    const ids = new Set(pending === '' ? [] : pending.split(' '))
    for (const [id, release] of held.current) {
      if (ids.has(id)) continue
      release()
      held.current.delete(id)
    }
    for (const id of ids) {
      if (!held.current.has(id)) held.current.set(id, hold(id).release)
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

// Syncs the match while the calling page is mounted, and gives `onBoard`
// each board it pulls: when the page opens, after each board the server
// takes, and every PULL_MS while the page is visible. It returns where the
// sync stands.
export function useBoardSync(matchId: string, onBoard: OnBoard): SyncStatus {
  const watcher = useRef(onBoard)
  useEffect(() => {
    watcher.current = onBoard
  })
  useEffect(() => {
    const { sync, release } = hold(matchId, watcher)
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') sync.pullSoon()
    }, PULL_MS)
    return () => {
      clearInterval(poll)
      release()
    }
  }, [matchId])
  return useSyncExternalStore(
    (listener) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
    () => syncs.get(matchId)?.status ?? IDLE,
  )
}
