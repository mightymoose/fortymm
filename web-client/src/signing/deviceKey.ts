import type { ApiClient } from '../api/client'
import { toHex, type Bytes } from './bytes'
import { deviceLabel } from './deviceLabel'
import { deleteDeviceKey, loadDeviceKey, saveDeviceKey, type DeviceKey } from './deviceStore'
import { coseKey, keyId, registrationProof, sign, type CoseSignature, type Side } from './signedResults'

// The device's signing key: one P-256 key per browser, which signs the
// results this device approves. It lives in IndexedDB (deviceStore.ts).

const P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const

// Two tabs that load at once would each make a key. The lock makes the
// second wait, then find the first one's key.
const LOCK = 'fortymm.device-key'

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
  await withLock(async () => {
    const key = (await loadDeviceKey()) ?? (await newDeviceKey())
    if ((await register(api, key, accountId)) === 'usable') return
    await register(api, await newDeviceKey(), accountId)
  })
}

// The id the API knows the device's key by, for the sign-out.
export async function deviceKeyId(): Promise<string | null> {
  const key = await loadDeviceKey()
  return key && toHex(key.kid)
}

// After a sign-out. The next account on this browser gets a new key.
export async function forgetDeviceKey(): Promise<void> {
  await deleteDeviceKey()
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
): Promise<'usable' | 'unusable'> {
  const { data, response } = await api.POST('/v1/account/signing-keys', {
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

function withLock(run: () => Promise<void>): Promise<void> {
  return 'locks' in navigator ? navigator.locks.request(LOCK, run) : run()
}
