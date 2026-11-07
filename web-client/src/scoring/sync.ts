import { useEffect, useRef, useSyncExternalStore } from 'react'
import { ApiError, ApiUnreachable } from '../api/errors'
import { acknowledge, boardsOf, dropBoard, matchesWithPending, subscribeBoards, type Refusal } from './boards'
import { putBoard } from './demoServer'

// Sends a match's board to the server in the background, so spectators and
// tournament directors can watch it. It's best effort: the URL keeps the
// scores, and nothing waits on a send or fails with it. Only the newest
// board saved goes, one send at a time, so a late older copy from this tab
// can't land after a newer one. While the browser knows it's offline, it
// sends nothing until `online` or the page resumes. A board the server
// can't take now waits, with a backoff, or until the same. A 429 waits out
// its Retry-After instead, which nothing cuts short. One it refuses for
// good (a 4xx other than 429) is dropped, and never shows as synced. It
// never reads the server's board back, so a board another device sent
// can't change this tab's pad.

// Two separate facts about a match's sync. A stuck board that is trying
// again is both stuck and sending.
export type SyncStatus = {
  sending: boolean
  // Why the sync is stuck, until a send gets through. One failed send
  // with a response doesn't count yet.
  stuck: 'offline' | 'failed' | null
  // Why the server last refused a board, until it takes one. It outlasts
  // the sync, so a refusal sent with the scoring page closed still shows.
  refused: Refusal | null
  // How many boards the server took while this sync lived. A game that
  // stops being unsynced with no rise here was dropped, not synced.
  landed: number
}

const IDLE: SyncStatus = { sending: false, stuck: null, refused: null, landed: 0 }

const RETRY_MS = [2000, 4000, 8000, 15000, 30000]

export function retryDelay(failures: number): number {
  return RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]
}

const RATE_LIMIT_MAX_MS = 300_000

function rateLimitDelay(retryAt: Date | null, backoff: number, now: number): number {
  const retryAfter = retryAt === null ? 0 : retryAt.getTime() - now
  return Math.min(Math.max(backoff, retryAfter), RATE_LIMIT_MAX_MS)
}

function rateLimited(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 429
}

export function retryable(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500 || rateLimited(error)
}

// Why a sync is stuck after its `failures`th failed send in a row. No
// response means the device is offline. A response, even a 502 to 504 from
// Cloudflare, means the server is failing, which the strip only says from
// the second failure, so one blip shows nothing. A 429 says so at once,
// as its wait can last minutes.
export function stuckAfter(error: unknown, failures: number, stuck: SyncStatus['stuck']): SyncStatus['stuck'] {
  if (error instanceof ApiUnreachable) return 'offline'
  if (rateLimited(error)) return 'failed'
  return failures >= 2 ? 'failed' : stuck
}

export type Step = 'send' | 'waitOnline' | 'rest'

// What an idle sync does next.
export function nextStep({ pending, offline }: { pending: string | null; offline: boolean }): Step {
  if (pending === null) return 'rest'
  return offline ? 'waitOnline' : 'send'
}

type State =
  | { kind: 'idle' }
  | { kind: 'sending'; board: string }
  | { kind: 'waitingRetry'; timer: ReturnType<typeof setTimeout>; rateLimited: boolean }
  | { kind: 'waitingOnline' }
  | { kind: 'stopped' }

const statusListeners = new Set<() => void>()

let onForbidden = (): void => {}

class MatchSync {
  status: SyncStatus = IDLE
  holders = 0
  private state: State = { kind: 'idle' }
  private stuck: SyncStatus['stuck'] = null
  private landed = 0
  private failures = 0
  private readonly unsubscribe: () => void
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
    document.addEventListener('visibilitychange', this.resume)
    window.addEventListener('pageshow', this.kick)
  }

  // Syncs now rather than at the next retry, as when the browser comes back
  // online or the page opens. A 429's wait is the server's to end.
  readonly kick = (): void => {
    if (this.state.kind === 'waitingRetry' && this.state.rateLimited) return
    if (this.state.kind === 'waitingRetry') clearTimeout(this.state.timer)
    if (this.state.kind === 'waitingRetry' || this.state.kind === 'waitingOnline') this.enter({ kind: 'idle' })
    void this.step()
  }

  // iOS Safari can resume a page without firing `online`, so a board
  // waiting for it would wait until the next save.
  private readonly resume = (): void => {
    if (document.visibilityState === 'visible') this.kick()
  }

  stop(): void {
    if (this.state.kind === 'waitingRetry') clearTimeout(this.state.timer)
    this.state = { kind: 'stopped' }
    this.unsubscribe()
    window.removeEventListener('online', this.kick)
    document.removeEventListener('visibilitychange', this.resume)
    window.removeEventListener('pageshow', this.kick)
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
      stuck: this.stuck,
      refused: boardsOf(this.matchId).refused,
      landed: this.landed,
    }
    for (const listener of statusListeners) listener()
  }

  private async step(): Promise<void> {
    if (this.state.kind !== 'idle') return
    const { pending } = boardsOf(this.matchId)
    switch (nextStep({ pending, offline: !navigator.onLine })) {
      case 'rest':
        this.stuck = null
        this.enter({ kind: 'idle' })
        return
      case 'waitOnline':
        this.stuck = 'offline'
        this.enter({ kind: 'waitingOnline' })
        return
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
        const backoff = retryDelay(this.failures)
        const limited = rateLimited(error)
        const delay = limited ? rateLimitDelay(error.retryAt, backoff, Date.now()) : backoff
        this.failures += 1
        this.stuck = stuckAfter(error, this.failures, this.stuck)
        this.enter({
          kind: 'waitingRetry',
          rateLimited: limited,
          timer: setTimeout(() => {
            this.enter({ kind: 'idle' })
            void this.step()
          }, delay),
        })
        return
      }
      if (error instanceof ApiError) this.refuse(board, error)
      return
    }
    if (!this.isIn(sending)) return
    this.failures = 0
    this.stuck = null
    // The rise and the acknowledge must reach the strip in one render, so
    // nothing may await between them.
    this.landed += 1
    this.enter({ kind: 'idle' })
    acknowledge(this.matchId, board)
    void this.step()
  }

  // Drops a board the server won't take, and never sends it again.
  private refuse(board: string, error: ApiError): void {
    // The boards route also answers 409 when the board's players or rules
    // differ from the server's match, which only a hand-edited link reaches.
    const refused = error.status === 409 ? 'final' : 'other'
    if (refused === 'other') console.warn('The server refused a board', error.status, error.title)
    if (error.status === 403) onForbidden()
    this.failures = 0
    this.enter({ kind: 'idle' })
    dropBoard(this.matchId, board, refused)
    void this.step()
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

// Syncs every match with a board to send, whichever page is open. Root runs
// it, so a board saved with no signal goes once the device is back online,
// even after the scoring page has closed. A refusal for want of permission
// calls `forbidden`, so Root can refresh the session.
export function useAppSync(forbidden: () => void): void {
  useEffect(() => {
    onForbidden = forbidden
    return () => {
      onForbidden = () => {}
    }
  }, [forbidden])
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

// Syncs the match while the calling page is mounted, and returns where the
// sync stands. A match that isn't `enabled` holds nothing and stays idle.
export function useBoardSync(matchId: string, enabled: boolean): SyncStatus {
  useEffect(() => (enabled ? hold(matchId) : undefined), [matchId, enabled])
  return useSyncExternalStore(
    (listener) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
    () => (enabled ? (syncs.get(matchId)?.status ?? IDLE) : IDLE),
  )
}
