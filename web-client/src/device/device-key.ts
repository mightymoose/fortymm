import { appendLock } from './locks.ts'

// This device's signing key (design 4.4 and 5.4, the Web rows): a WebCrypto ECDSA P-256 key pair
// whose private half is not extractable, kept in IndexedDB as the CryptoKey objects themselves.
// Script on the app's origin can ask it to sign but cannot copy it.
//
// First use makes exactly one key per device, however many tabs open at once (J6): the key is made
// inside the journal's append lock, and a caller looks for a kept key only once it holds the lock
// (CreateDeviceKey in requirements/tla/Journal.tla).
//
// The browser can delete the key with the rest of the site's storage (cleared site data, a private
// window closing, Safari's eviction). The next call then makes a new one: a new device.

// Both halves, as kept. The public half is no secret; it is kept beside the private one so the
// pair is read in one go.
export type DeviceKeyPair = { privateKey: CryptoKey; publicKey: CryptoKey }

// Why there is no device key. None of them leaves a key that isn't kept.
// - signing-unavailable: no WebCrypto ECDSA P-256 (an insecure context has no crypto.subtle).
// - storage-unavailable: no IndexedDB, or it refused to open, read or write the key, or the lock
//   request was refused (blocked site data, some private windows).
// - locks-unavailable: no Web Locks, so two tabs could each make a key.
export type DeviceKeyFailure = 'signing-unavailable' | 'storage-unavailable' | 'locks-unavailable'

// - made: no key was kept, and this call made and kept one.
// - kept: a key was already kept.
export type DeviceKeyResult =
  | { ok: true; outcome: 'made' | 'kept'; pair: DeviceKeyPair }
  | { ok: false; reason: DeviceKeyFailure }

// Where the key is kept: a database of its own, with one store and one entry.
export const keyDatabase = 'fortymm-device-key'
export const keyStore = 'keys'
export const keyEntry = 'signing'

const algorithm = { name: 'ECDSA', namedCurve: 'P-256' } as const

type Failure = { ok: false; reason: DeviceKeyFailure }

// This device's key: the kept one, or, if none is kept, a new one, made and kept first. Two
// callers at once, in one page or in two tabs, get the same key. Never throws.
export async function deviceKey(): Promise<DeviceKeyResult> {
  if (globalThis.crypto?.subtle === undefined) return failure('signing-unavailable')
  if (globalThis.indexedDB === undefined) return failure('storage-unavailable')
  if (globalThis.navigator?.locks === undefined) return failure('locks-unavailable')

  try {
    return await navigator.locks.request(appendLock, keptOrMade)
  } catch {
    // The lock request itself was refused (keptOrMade never throws).
    return failure('storage-unavailable')
  }
}

// Inside the lock. Another caller may have made the key while this one waited for it.
async function keptOrMade(): Promise<DeviceKeyResult> {
  let database: IDBDatabase
  try {
    database = await openKeyDatabase()
  } catch {
    return failure('storage-unavailable')
  }
  try {
    let kept: DeviceKeyPair | undefined
    try {
      kept = await readPair(database)
    } catch {
      return failure('storage-unavailable')
    }
    if (kept !== undefined) return { ok: true, outcome: 'kept', pair: kept }

    let pair: DeviceKeyPair
    try {
      pair = await crypto.subtle.generateKey(algorithm, false, ['sign', 'verify'])
    } catch {
      return failure('signing-unavailable')
    }
    try {
      await addPair(database, pair)
    } catch {
      return failure('storage-unavailable')
    }
    return { ok: true, outcome: 'made', pair }
  } finally {
    database.close()
  }
}

function failure(reason: DeviceKeyFailure): Failure {
  return { ok: false, reason }
}

function openKeyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(keyDatabase, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(keyStore)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('The key database is blocked'))
  })
}

function readPair(database: IDBDatabase): Promise<DeviceKeyPair | undefined> {
  return new Promise((resolve, reject) => {
    const request = database.transaction(keyStore, 'readonly').objectStore(keyStore).get(keyEntry)
    request.onsuccess = () => resolve(request.result as DeviceKeyPair | undefined)
    request.onerror = () => reject(request.error)
  })
}

// Resolves once the key is on disk: a strict transaction where the browser offers one. `add`, not
// `put`: should the lock ever fail to keep two makers apart, the second fails rather than
// replacing a key that may already have signed something.
function addPair(database: IDBDatabase, pair: DeviceKeyPair): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(keyStore, 'readwrite', { durability: 'strict' })
    transaction.objectStore(keyStore).add(pair, keyEntry)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}
