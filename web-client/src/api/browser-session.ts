import { useSyncExternalStore } from 'react'
import { z } from 'zod'

const KEY = 'fortymm.session-ended'
const CHANGE = 'fortymm:session-ended'
const endedSchema = z.object({
  message: z.string(),
  email: z.string().optional(),
  logoutPending: z.boolean().optional(),
})
export type EndedSession = z.infer<typeof endedSchema>
let unavailableStorageValue: string | null = null
let storageWriteFailed = false

function tabSnapshot(): string | null {
  try { return sessionStorage.getItem(KEY) } catch { return null }
}

function persistTabSnapshot(value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(KEY)
    else sessionStorage.setItem(KEY, value)
  } catch { /* The in-memory fallback still protects this open tab. */ }
}

function persist(value: string | null): void {
  unavailableStorageValue = value
  try {
    localStorage.setItem(KEY, value ?? 'null')
    storageWriteFailed = false
    persistTabSnapshot(null)
  } catch {
    storageWriteFailed = true
    persistTabSnapshot(value)
  }
}

function broadcast(value: string | null): void {
  if (typeof BroadcastChannel === 'undefined') return
  try {
    const channel = new BroadcastChannel(CHANGE)
    channel.postMessage(JSON.stringify({ sender: tabId, value: value === null ? null : JSON.parse(value) }))
    channel.close()
  } catch { /* Shared storage remains the primary broadcast transport. */ }
}

function snapshot(): string | null {
  if (storageWriteFailed) return unavailableStorageValue
  try { return localStorage.getItem(KEY) ?? tabSnapshot() }
  catch { return unavailableStorageValue ?? tabSnapshot() }
}

/** Reconcile peer completion synchronously while holding the recovery lock. */
export function synchronizeSessionEnd(): void {
  try {
    const shared = localStorage.getItem(KEY)
    const value = shared ?? snapshot() ?? 'null'
    // A stored null records completed recovery, even if this tab still has a
    // fallback ended marker and has not received the peer's broadcast yet.
    endedSchema.nullable().parse(JSON.parse(value))
    localStorage.setItem(KEY, value)
    storageWriteFailed = false
    unavailableStorageValue = value
    persistTabSnapshot(null)
  } catch {
    throw new Error('Session recovery is unavailable. Please enable browser storage and try again.')
  }
}

export function readEndedSession(): EndedSession | null {
  try {
    const parsed = endedSchema.safeParse(JSON.parse(snapshot() ?? 'null'))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function subscribeSessionEnd(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) {
      storageWriteFailed = false
      unavailableStorageValue = event.newValue
      persistTabSnapshot(null)
      listener()
    }
  }
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANGE)
  if (channel) channel.onmessage = (event) => {
    try {
      if (typeof event.data !== 'string') return
      const parsed = z.object({ sender: z.string(), value: endedSchema.nullable() }).safeParse(JSON.parse(event.data))
      if (!parsed.success || parsed.data.sender === tabId) return
      const value = parsed.data.value === null ? null : JSON.stringify(parsed.data.value)
      if (snapshot() === value) return
      persist(value)
      window.dispatchEvent(new Event(CHANGE))
    } catch { /* Ignore malformed channel messages. */ }
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener(CHANGE, listener)
  return () => {
    channel?.close()
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(CHANGE, listener)
  }
}

export function rememberSessionEnd(info: EndedSession, { notifyLocal = true }: { notifyLocal?: boolean } = {}): void {
  const value = JSON.stringify(info)
  if (snapshot() === value) return
  persist(value)
  broadcast(value)
  if (notifyLocal) window.dispatchEvent(new Event(CHANGE))
}

export function forgetSessionEnd(): void {
  persist(null)
  broadcast(null)
  window.dispatchEvent(new Event(CHANGE))
}

export function useEndedSession(): EndedSession | null {
  useSyncExternalStore(subscribeSessionEnd, snapshot, () => null)
  return readEndedSession()
}

const IDENTITY_KEY = 'fortymm.identity-change'
const IDENTITY_CHANNEL = 'fortymm:identity-change'
const tabId = crypto.randomUUID()
const identityMessageSchema = z.object({ sender: z.string(), revision: z.string() })

/** Tell other tabs to reload their account data after credentials change. */
export function announceIdentityChange(): void {
  const message = JSON.stringify({ sender: tabId, revision: crypto.randomUUID() })
  try { localStorage.setItem(IDENTITY_KEY, message) } catch { /* Channel fallback. */ }
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(IDENTITY_CHANNEL)
    channel.postMessage(message)
    channel.close()
  }
}

export function subscribeIdentityChange(listener: () => void): () => void {
  let lastRevision: string | undefined
  const receive = (raw: unknown) => {
    try {
      if (typeof raw !== 'string') return
      const parsed = identityMessageSchema.safeParse(JSON.parse(raw))
      if (!parsed.success || parsed.data.sender === tabId || parsed.data.revision === lastRevision) return
      lastRevision = parsed.data.revision
      listener()
    } catch { /* Ignore malformed storage or channel messages. */ }
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key === IDENTITY_KEY) receive(event.newValue)
  }
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(IDENTITY_CHANNEL)
  if (channel) channel.onmessage = (event) => receive(event.data)
  window.addEventListener('storage', onStorage)
  return () => {
    channel?.close()
    window.removeEventListener('storage', onStorage)
  }
}
