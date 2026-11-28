import { loadCore, type Core } from '../core/load-core.ts'
import { deviceKey, type DeviceKeyFailure } from './device-key.ts'

// Who this device is (design 8.6, whoami), worked out from its key alone, with no server. A key
// needs no registration: its account and its own player are computed from it (design 4, "Derived
// ids"), and so is the player's generated username (design 8.4).
//
// Until the server has answered, this is only what the device can know for itself:
// - the account is a guest's: approving it takes a verified email address (D4);
// - the username is the provisional four-character form. The server confirms it when it first
//   sees the player, and on a rare clash the later arrival gets five characters (8.4,
//   "Confirmation"); a longer form always starts with this one;
// - a guest speaks for exactly one player, its own (I4).

// Ids are lower-case hex.
export type Identity = {
  accountId: string
  playerId: string
  username: string
  usernameConfirmed: false
  account: 'guest'
}

// Why there is no identity: the device key's reasons, or the core's wasm failed to load.
export type WhoamiFailure = DeviceKeyFailure | 'core-unavailable'

export type WhoamiResult = { ok: true; identity: Identity } | { ok: false; reason: WhoamiFailure }

// The suffix a device shows before the server confirms the name (design 8.4).
const provisionalSuffixLength = 4

// This device's identity. Makes the device key if none is kept yet, as landing does (J6), so two
// callers at once still get one key. Never throws.
export async function whoami(): Promise<WhoamiResult> {
  const key = await deviceKey()
  if (!key.ok) return { ok: false, reason: key.reason }

  let core: Core
  try {
    core = await loadCore()
  } catch {
    return { ok: false, reason: 'core-unavailable' }
  }
  // The public half of a WebCrypto key is always exportable, whatever the private half is.
  const exported = new Uint8Array(await crypto.subtle.exportKey('raw', key.pair.publicKey))
  return { ok: true, identity: identityOf(exported, core) }
}

// The identity of a public key as WebCrypto exports it raw (65 bytes, uncompressed).
export function identityOf(exportedPublicKey: Uint8Array, core: Core): Identity {
  const publicKey = core.compress_public_key(exportedPublicKey)
  const playerId = core.own_player_id(publicKey)
  return {
    accountId: hex(core.account_id(publicKey)),
    playerId: hex(playerId),
    username: core.username(playerId, provisionalSuffixLength),
    usernameConfirmed: false,
    account: 'guest',
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
