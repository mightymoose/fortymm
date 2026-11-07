import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { ApiClient } from '../api/client'
import { ApiError, ApiUnreachable } from '../api/errors'
import { pushBoard, pushResult } from './boardApi'
import { acknowledge, boardsOf, dropBoard, matchesWithPending, subscribeBoards, type Refusal } from './boards'
import { matchesWithResults, notYet, removeResult, resultsOf, staleResult, subscribeResults, unknownKey } from './results'

// Sends a match's board to the API in the background, so spectators and
// tournament directors can watch it. It's best effort: the URL keeps the
// scores, and nothing waits on a send or fails with it. Only the newest
// board saved goes, one send at a time, so a late older copy from this tab
// can't land after a newer one. While the browser knows it's offline, it
// sends nothing until `online` or the page resumes. A board the server
// can't take now waits, with a backoff, or until the same. A 429 waits out
// its Retry-After instead, which nothing cuts short. A 401 waits the same
// backoff while the session is refreshed. One it refuses for good (any
// other 4xx) is dropped, and never shows as synced. It
// never reads the server's board back, so a board another device sent
// can't change this tab's pad.
//
// A submitted result goes the same way, after the board, to the approvals
// route, which records it with the submitter's signature. The server's
// chain then has a head, so a correction can replace it. Every result goes,
// oldest first, because each replaces the one before. One the server
// refuses for good is dropped, and the next one goes. Two refusals can
// mean "not yet", so a result keeps trying after them for a day from its
// signing: a stale one, whose first result is still on another phone, and
// an unknown key, which this device registers on its next session answer.

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

// Where a match with no sync stands: idle, but still saying why the server
// last refused its board. One object per answer, so the snapshot is stable.
const IDLE_REFUSED: Record<Refusal, SyncStatus> = {
  final: { ...IDLE, refused: 'final' },
  other: { ...IDLE, refused: 'other' },
}
function idleStatus(matchId: string): SyncStatus {
  const { refused } = boardsOf(matchId)
  return refused ? IDLE_REFUSED[refused] : IDLE
}

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

// The session lapsed, or another account adopted this one. A refreshed
// session can send the board.
function sessionLapsed(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401
}

// After the backoff, a result that isn't taken yet tries this often, or
// when the page wakes.
const NOT_YET_RETRY_MS = 300_000

export function retryable(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500 || rateLimited(error) || sessionLapsed(error)
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

export type Step = 'sendBoard' | 'sendResult' | 'waitOnline' | 'rest'

// What an idle sync does next. The board goes before a result, so the
// board that shows the result's scores lands while the match can still
// take it.
export function nextStep({
  pending,
  result,
  offline,
}: {
  pending: string | null
  result: string | null
  offline: boolean
}): Step {
  if (pending === null && result === null) return 'rest'
  if (offline) return 'waitOnline'
  return pending === null ? 'sendResult' : 'sendBoard'
}

type Sent = { kind: 'board' | 'result'; text: string }

type State =
  | { kind: 'idle' }
  | { kind: 'sending'; sent: Sent }
  | { kind: 'waitingRetry'; timer: ReturnType<typeof setTimeout>; rateLimited: boolean; notYet: boolean }
  | { kind: 'waitingOnline' }
  | { kind: 'stopped' }

const statusListeners = new Set<() => void>()

let refreshSession = (): void => {}
// Results go only while a session is loaded. Elsewhere a 401 would make
// the refresh start a guest account, as on /signed-out.
let resultsEnabled = false

class MatchSync {
  status: SyncStatus = IDLE
  holders = 0
  private state: State = { kind: 'idle' }
  private stuck: SyncStatus['stuck'] = null
  private landed = 0
  private failures = 0
  // The results that came back stale in this pass. A pass sends every
  // queued result once, oldest first, as a later one may be what an
  // earlier one replaces. Any result settling, or any wait, starts a new
  // pass.
  private readonly stale = new Set<string>()
  private readonly unsubscribe: () => void
  private readonly unsubscribeResults: () => void
  private readonly matchId: string
  private readonly api: ApiClient

  constructor(matchId: string, api: ApiClient) {
    this.matchId = matchId
    this.api = api
    // A save, here or in another component. A waiting retry keeps its
    // backoff.
    // A result that isn't taken yet waits minutes, which neither a board,
    // sent first, nor a new result, perhaps the one it replaces, waits out.
    const saved = () => {
      if (this.state.kind === 'waitingRetry' && this.state.notYet) clearTimeout(this.state.timer)
      if (this.state.kind === 'waitingOnline' || (this.state.kind === 'waitingRetry' && this.state.notYet)) {
        this.enter({ kind: 'idle' })
      }
      void this.step()
    }
    this.unsubscribe = subscribeBoards(saved)
    this.unsubscribeResults = subscribeResults(saved)
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
    this.unsubscribeResults()
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
    const result = this.nextResult()
    switch (nextStep({ pending, result: resultsEnabled ? result : null, offline: !navigator.onLine })) {
      case 'rest':
        this.stuck = null
        this.enter({ kind: 'idle' })
        return
      case 'waitOnline':
        this.stuck = 'offline'
        this.enter({ kind: 'waitingOnline' })
        return
      case 'sendBoard':
        return this.send({ kind: 'board', text: pending! })
      case 'sendResult':
        return this.send({ kind: 'result', text: result! })
    }
  }

  private async send(sent: Sent): Promise<void> {
    const sending: State = { kind: 'sending', sent }
    this.enter(sending)
    try {
      if (sent.kind === 'board') await pushBoard(this.api, this.matchId, sent.text)
      else await pushResult(this.api, this.matchId, sent.text)
    } catch (error) {
      if (!this.isIn(sending)) return
      if (sessionLapsed(error) || (error instanceof ApiError && error.status === 403) || unknownKey(error)) {
        refreshSession()
      }
      const later = sent.kind === 'result' && notYet(error, sent.text, Date.now())
      if (later && staleResult(error)) {
        this.stale.add(sent.text)
        if (this.nextResult() !== null) {
          this.enter({ kind: 'idle' })
          void this.step()
          return
        }
      }
      this.stale.clear()
      if (retryable(error) || later) {
        const delay = this.retryDelayFor(error, later)
        const limited = rateLimited(error)
        this.failures += 1
        // A result that isn't taken yet is no sign that the sync is stuck.
        if (!later) this.stuck = stuckAfter(error, this.failures, this.stuck)
        this.enter({
          kind: 'waitingRetry',
          rateLimited: limited,
          notYet: later,
          timer: setTimeout(() => {
            this.enter({ kind: 'idle' })
            void this.step()
          }, delay),
        })
        return
      }
      if (error instanceof ApiError) this.refuse(sent, error)
      return
    }
    if (!this.isIn(sending)) return
    this.failures = 0
    this.stuck = null
    if (sent.kind === 'result') return this.settle(sent.text)
    // The rise and the acknowledge must reach the strip in one render, so
    // nothing may await between them.
    this.landed += 1
    this.enter({ kind: 'idle' })
    acknowledge(this.matchId, sent.text)
    void this.step()
  }

  // The oldest queued result not yet stale in this pass.
  private nextResult(): string | null {
    return resultsOf(this.matchId).find((result) => !this.stale.has(result)) ?? null
  }

  // A 429 waits out its Retry-After. A result that isn't taken yet tries
  // less often once the backoff runs out.
  private retryDelayFor(error: unknown, notYet: boolean): number {
    const backoff = retryDelay(this.failures)
    if (rateLimited(error)) return rateLimitDelay(error.retryAt, backoff, Date.now())
    return notYet && this.failures >= RETRY_MS.length ? NOT_YET_RETRY_MS : backoff
  }

  // The server took the result, or refused it for good, so the next goes
  // once the outbox, which may wait for another tab, has changed.
  private settle(result: string): void {
    this.stale.clear()
    this.enter({ kind: 'idle' })
    removeResult(this.matchId, result)
  }

  // Drops a board or a result the server won't take, and never sends it
  // again.
  private refuse(sent: Sent, error: ApiError): void {
    this.failures = 0
    if (sent.kind === 'result') {
      console.warn('The server refused a result', error.status, error.title)
      return this.settle(sent.text)
    }
    // The boards route also answers 409 when the board's players or rules
    // differ from the server's match, which only a hand-edited link reaches.
    const refused = error.status === 409 ? 'final' : 'other'
    if (refused === 'other') console.warn('The server refused a board', error.status, error.title)
    this.enter({ kind: 'idle' })
    dropBoard(this.matchId, sent.text, refused)
    void this.step()
  }
}

const syncs = new Map<string, MatchSync>()

function subscribeToSend(listener: () => void): () => void {
  const unsubscribeBoards = subscribeBoards(listener)
  const unsubscribeResults = subscribeResults(listener)
  return () => {
    unsubscribeBoards()
    unsubscribeResults()
  }
}

// The matches with a board or a result to send, as one string, so a React
// store can compare it.
function matchesToSend(): string {
  const boards = matchesWithPending()
  return [...new Set([...(boards === '' ? [] : boards.split(' ')), ...matchesWithResults()])].sort().join(' ')
}

// Syncs the match until the returned release is called. Root and the
// scoring page each hold a match, and its sync stops when the last lets go.
// A response that lands after that changes nothing.
function hold(matchId: string, api: ApiClient): () => void {
  let sync = syncs.get(matchId)
  if (!sync) {
    sync = new MatchSync(matchId, api)
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

// Syncs every match with a board or a result to send, whichever page is
// open. Root runs it, so a board saved with no signal goes once the device
// is back online, even after the scoring page has closed, and a result
// after a reload too. A 401, or a refusal for want of
// permission, calls `refresh`, so Root can refresh the session.
export function useAppSync(api: ApiClient, refresh: () => void, signedIn: boolean): void {
  useEffect(() => {
    refreshSession = refresh
    return () => {
      refreshSession = () => {}
    }
  }, [refresh])
  useEffect(() => {
    resultsEnabled = signedIn
    if (signedIn) for (const sync of syncs.values()) sync.kick()
    return () => {
      resultsEnabled = false
    }
  }, [signedIn])
  const pending = useSyncExternalStore(subscribeToSend, signedIn ? matchesToSend : matchesWithPending)
  const held = useRef(new Map<string, () => void>())
  useEffect(() => {
    const ids = new Set(pending === '' ? [] : pending.split(' '))
    for (const [id, release] of held.current) {
      if (ids.has(id)) continue
      release()
      held.current.delete(id)
    }
    for (const id of ids) {
      if (!held.current.has(id)) held.current.set(id, hold(id, api))
    }
  }, [pending, api])
  useEffect(() => {
    const releases = held.current
    return () => {
      for (const release of releases.values()) release()
      releases.clear()
    }
  }, [])
}

// Syncs the match while the calling page is mounted, and returns where the
// sync stands. A match that isn't `enabled` holds nothing and stays idle,
// but still shows a refusal, such as a 403 that took away its permission
// to sync.
export function useBoardSync(matchId: string, enabled: boolean, api: ApiClient): SyncStatus {
  useEffect(() => (enabled ? hold(matchId, api) : undefined), [matchId, enabled, api])
  return useSyncExternalStore(
    (listener) => {
      statusListeners.add(listener)
      const unsubscribe = subscribeBoards(listener)
      return () => {
        statusListeners.delete(listener)
        unsubscribe()
      }
    },
    () => (enabled ? (syncs.get(matchId)?.status ?? idleStatus(matchId)) : idleStatus(matchId)),
  )
}
