import type { ApiClient } from '../api/client'
import { toHex, type Bytes } from './bytes'
import { deviceLabel } from './deviceLabel'
import { deleteDeviceKey, loadDeviceKey, saveDeviceKey, type DeviceKey } from './deviceStore'
import { coseKey, keyId, registrationProof, sign, type CoseSignature, type Side } from './signedResults'

// The device's signing key: one P-256 key per browser, which signs the
// results this device approves. It lives in IndexedDB (deviceStore.ts).

const P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const

// Every read and write of the stored key takes this lock, in every tab.
// Two tabs that load at once would each make a key, and a registration that
// finished after a sign-out would save a key for an account that left.
const LOCK = 'fortymm.device-key'

// The registrations this tab started, which a sign-out cancels.
const registrations = new Set<AbortController>()

// Registers the device's key to the session's account, after the session
// starts. With no key, such as on a first visit or after Safari deleted the
// site's storage, it makes one first. A key that another account owns, or
// that was revoked, can't sign for this account, so it makes a new one.
//
// The API answers 200 for a key the account already owns, so every online
// load registers again. That also covers a sign-in that moved the session to
// another account. A failure, such as no network, throws, and the next
// online load tries again.
export async function registerDeviceKey(api: ApiClient, accountId: string): Promise<void> {
  const cancel = new AbortController()
  registrations.add(cancel)
  try {
    await withLock(async () => {
      const { signal } = cancel
      signal.throwIfAborted()
      const key = (await loadDeviceKey()) ?? (await newDeviceKey())
      if ((await register(api, key, accountId, signal)) === 'usable') return
      signal.throwIfAborted()
      await register(api, await newDeviceKey(), accountId, signal)
    })
  } finally {
    registrations.delete(cancel)
  }
}

// Signs the device out: `logout` ends the session on the API, given the id
// of the device's key, or null with no key. Then the key is deleted, and the
// next account on this browser gets a new one. If `logout` throws, such as
// with no network, the key stays.
//
// It cancels this tab's registrations, so one waiting on a slow answer
// doesn't hold up the sign-out, and none saves a key after it. It holds the
// lock throughout, so another tab's registration waits or finishes first.
export async function signOutDeviceKey<T>(
  logout: (signingKeyId: string | null) => Promise<T>,
): Promise<T> {
  registrations.forEach((cancel) => cancel.abort())
  return withLock(async () => {
    const key = await loadDeviceKey().catch(() => null)
    const result = await logout(key && toHex(key.kid))
    await deleteDeviceKey().catch(() => {})
    return result
  })
}

// Approves `payload` for `side` with the device's key, or null if the
// device has none.
export async function signWithDeviceKey(
  side: Side,
  payload: Bytes,
): Promise<CoseSignature | null> {
  const key = await loadDeviceKey()
  return key && sign(key, side, payload)
}

async function register(
  api: ApiClient,
  key: DeviceKey,
  accountId: string,
  signal: AbortSignal,
): Promise<'usable' | 'unusable'> {
  const { data, response } = await api.POST('/v1/account/signing-keys', {
    signal,
    body: {
      public_key: toHex(key.coseKey),
      proof: toHex(await registrationProof(key, accountId)),
      label: deviceLabel(navigator.userAgent),
    },
  })
  if (response.status === 409) return 'unusable'
  if (!data) throw new Error(`POST /v1/account/signing-keys answered ${response.status}`)
  return data.data.revoked_at === null ? 'usable' : 'unusable'
}

async function newDeviceKey(): Promise<DeviceKey> {
  const pair = await crypto.subtle.generateKey(P256, false, ['sign'])
  // 0x04, then the 32-byte x and y.
  const point = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const cose = coseKey(point.slice(1, 33), point.slice(33))
  const key = { privateKey: pair.privateKey, coseKey: cose, kid: await keyId(cose) }
  await saveDeviceKey(key)
  return key
}

// Without Web Locks, the tab's own calls still take turns.
let queue: Promise<unknown> = Promise.resolve()

function withLock<T>(run: () => Promise<T>): Promise<T> {
  if ('locks' in navigator) return navigator.locks.request(LOCK, run)
  const turn = queue.then(run)
  queue = turn.catch(() => {})
  return turn
}
