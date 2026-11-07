import { ApiError, STALE_RESULT, UNKNOWN_KEY } from '../api/errors'
import { decodeEnvelope } from '../signing/envelope'
import { decodePayload } from '../signing/result'
import { fromBase64url } from '../signing/text'

// The signed results this device submitted that the server hasn't taken
// yet, per match and oldest first, each a fragment's text: an envelope.
// Each replaces the one before it, so the server takes them only in order,
// and a result can't wait in memory like a board: a correction whose
// first result a reload forgot could never be approved. So they stay in
// localStorage. Each change reads it afresh and writes it under a Web
// Lock, so two tabs' changes take turns rather than undo each other.
// Without storage they stay in this tab's memory.
type Outbox = Record<string, string[]>

const KEY = 'fortymm-results'

let fallback: Outbox = {}
// Once a write fails, storage can't be trusted to hold the outbox.
let storageFailed = false
const listeners = new Set<() => void>()

function read(): Outbox {
  if (storageFailed) return fallback
  try {
    const saved = localStorage.getItem(KEY)
    return saved === null ? {} : (JSON.parse(saved) as Outbox)
  } catch {
    return fallback
  }
}

function write(outbox: Outbox): void {
  fallback = outbox
  try {
    if (Object.keys(outbox).length === 0) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, JSON.stringify(outbox))
  } catch {
    storageFailed = true
  }
  for (const listener of listeners) listener()
}

// Applies `change` to the outbox as it stands, under the lock where the
// browser has one. Listeners hear once it is written.
function update(change: (outbox: Outbox) => Outbox): void {
  const run = () => write(change(read()))
  if (typeof navigator !== 'undefined' && navigator.locks) void navigator.locks.request(KEY, run)
  else run()
}

export function resultsOf(matchId: string): readonly string[] {
  return read()[matchId] ?? []
}

// A submit. The same envelope twice waits once.
export function queueResult(matchId: string, envelope: string): void {
  update((outbox) => {
    const queued = outbox[matchId] ?? []
    return queued.includes(envelope) ? outbox : { ...outbox, [matchId]: [...queued, envelope] }
  })
}

// The server took `envelope`, or refused it for good.
export function removeResult(matchId: string, envelope: string): void {
  update(({ [matchId]: queued = [], ...others }) => {
    const left = queued.filter((queuedEnvelope) => queuedEnvelope !== envelope)
    return left.length ? { ...others, [matchId]: left } : others
  })
}

export function forgetResults(): void {
  storageFailed = false
  write({})
}

// A change here, or in another tab.
export function subscribeResults(listener: () => void): () => void {
  listeners.add(listener)
  const fromAnotherTab = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) listener()
  }
  window.addEventListener('storage', fromAnotherTab)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', fromAnotherTab)
  }
}

// Resolves once nothing this device queued for the match before
// `envelope` still waits, or after `ms`, whichever comes first.
export function afterEarlierResults(matchId: string, envelope: string, ms: number): Promise<void> {
  const waiting = () => {
    const queued = resultsOf(matchId)
    const index = queued.indexOf(envelope)
    return (index === -1 ? queued.length : index) > 0
  }
  return new Promise((resolve) => {
    if (!waiting()) return resolve()
    const done = () => {
      clearTimeout(timer)
      unsubscribe()
      resolve()
    }
    const timer = setTimeout(done, ms)
    const unsubscribe = subscribeResults(() => {
      if (!waiting()) done()
    })
  })
}

export function matchesWithResults(): string[] {
  return Object.keys(read())
}

export function staleResult(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.title === STALE_RESULT
}

export function unknownKey(error: unknown): boolean {
  return error instanceof ApiError && error.status === 422 && error.title === UNKNOWN_KEY
}

const NOT_YET_FOR_MS = 24 * 60 * 60 * 1000
// How far ahead of this device's clock another phone's may run. A link's
// signing time isn't checked against its signature here, so a later one
// can't keep a refusal "not yet" for longer.
const CLOCK_AHEAD_MS = 60 * 60 * 1000

// Whether a refusal of `envelope` may still change, so the outbox sends it
// again and the approval page says it waits: the result it replaces may
// still arrive, the key may register, or the next session may hold
// `matches.score`.
export function notYet(error: unknown, envelope: string, now: number): boolean {
  if (!(error instanceof ApiError)) return false
  if (!staleResult(error) && !unknownKey(error) && error.status !== 403) return false
  try {
    const { issuedAt } = decodePayload(decodeEnvelope(fromBase64url(envelope)).payload)
    const age = now - issuedAt * 1000
    return age > -CLOCK_AHEAD_MS && age < NOT_YET_FOR_MS
  } catch {
    return false
  }
}
