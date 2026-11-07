// The signed results this device submitted that the server hasn't taken
// yet, per match and oldest first, each a fragment's text: an envelope.
// Each replaces the one before it, so the server takes them only in order,
// and a result can't wait in memory like a board: a correction whose
// first result a reload forgot could never be approved. So they stay in
// localStorage, read afresh on every change so two tabs don't undo each
// other's writes. Without storage they stay in this tab's memory.
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

export function resultsOf(matchId: string): readonly string[] {
  return read()[matchId] ?? []
}

// A submit. The same envelope twice waits once.
export function queueResult(matchId: string, envelope: string): void {
  const outbox = read()
  const queued = outbox[matchId] ?? []
  if (!queued.includes(envelope)) write({ ...outbox, [matchId]: [...queued, envelope] })
}

// The server took `envelope`, or refused it for good.
export function removeResult(matchId: string, envelope: string): void {
  const { [matchId]: queued = [], ...others } = read()
  const left = queued.filter((queuedEnvelope) => queuedEnvelope !== envelope)
  write(left.length ? { ...others, [matchId]: left } : others)
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
