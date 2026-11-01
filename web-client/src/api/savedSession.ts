import type { components } from './schema'

export type SessionAccount = components['schemas']['SessionAccount']

// The account of the last session that started, so a page load with no
// network can still show the authenticated pages. It is only what the pages
// show. The session itself is the HttpOnly cookie.
const KEY = 'fortymm.session'

// Storage can be missing or refuse access, such as in a private window. Then
// nothing is saved and the app behaves as it did before.
export function savedAccount(): SessionAccount | null {
  try {
    const saved = localStorage.getItem(KEY)
    return saved === null ? null : parseAccount(JSON.parse(saved))
  } catch {
    return null
  }
}

export function saveAccount(account: SessionAccount): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(account))
  } catch {
    // Nothing saved, so an offline load shows the error page.
  }
}

export function forgetAccount(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Storage that refuses access holds nothing to forget.
  }
}

// Another version of the app, or another script, may have written the key.
function parseAccount(value: unknown): SessionAccount | null {
  if (!isRecord(value) || !isRecord(value.player)) return null
  const { id, kind, email, player, permissions } = value
  const valid =
    typeof id === 'string' &&
    (kind === 'guest' || kind === 'verified') &&
    (email === null || typeof email === 'string') &&
    typeof player.id === 'string' &&
    typeof player.display_name === 'string' &&
    Array.isArray(permissions) &&
    permissions.every((permission) => typeof permission === 'string')
  return valid ? (value as SessionAccount) : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
