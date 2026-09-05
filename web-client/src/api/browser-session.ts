import { useSyncExternalStore } from 'react'
import { z } from 'zod'

const KEY = 'fortymm.session-ended'
const CHANGE = 'fortymm:session-ended'
const endedSchema = z.object({
  message: z.string(),
  email: z.string().optional(),
})
export type EndedSession = z.infer<typeof endedSchema>
let unavailableStorageValue: string | null = null
let storageWriteFailed = false

function snapshot(): string | null {
  if (storageWriteFailed) return unavailableStorageValue
  try {
    return localStorage.getItem(KEY)
  } catch {
    return unavailableStorageValue
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
      listener()
    }
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener(CHANGE, listener)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(CHANGE, listener)
  }
}

export function rememberSessionEnd(info: EndedSession): void {
  const value = JSON.stringify(info)
  if (snapshot() === value) return
  unavailableStorageValue = value
  try {
    localStorage.setItem(KEY, value)
    storageWriteFailed = false
  } catch {
    storageWriteFailed = true
  }
  window.dispatchEvent(new Event(CHANGE))
}

export function forgetSessionEnd(): void {
  unavailableStorageValue = null
  try {
    localStorage.removeItem(KEY)
    storageWriteFailed = false
  } catch {
    storageWriteFailed = true
  }
  window.dispatchEvent(new Event(CHANGE))
}

export function useEndedSession(): EndedSession | null {
  useSyncExternalStore(subscribeSessionEnd, snapshot, () => null)
  return readEndedSession()
}
