import type { Core } from 'fortymm-core/fortymm-core.mjs'

// This device's signing key (design sections 4.4 and 5.4, the Web row): a
// WebCrypto ECDSA P-256 key pair, made once, on first use, with a private key
// that is not extractable, and kept in IndexedDB as the CryptoKey objects
// themselves. Script on the app's origin can ask it to sign but cannot copy
// it. The core never touches the private key: it gets the public key and the
// signatures, in the forms records store.
//
// Only what makes records (the journal, later) signs with it; feature code
// never does (design section 4.3).
//
// The browser can delete the key with the rest of the site's storage (a
// cleared site, a private window closing, Safari's eviction): the next call
// then makes a new one.

// The key pair, as kept: both halves are CryptoKey objects, structured-cloned
// into IndexedDB. The public half is no secret; it is kept beside the private
// one so the pair is read in one go.
type KeptPair = { privateKey: CryptoKey; publicKey: CryptoKey }

export type DeviceKey = {
  // The public key as a record stores it: 33 bytes, compressed SEC1 (the
  // first byte 02 or 03). The core's accountId and ownPlayerId take it.
  publicKey: Uint8Array
  // Signs bytes with the private key (ECDSA, SHA-256), giving WebCrypto's
  // 64-byte r||s. storedSignature converts it to the form a record stores.
  sign: (bytes: Uint8Array) => Promise<Uint8Array>
}

// Why there is no device key. Neither makes a key that isn't kept: a key
// exists only once it is stored.
// - signing-unavailable: this browser has no WebCrypto ECDSA P-256 (an
//   insecure context has no crypto.subtle at all).
// - storage-unavailable: IndexedDB is missing, or refused to open, read or
//   store the key (blocked storage, some private windows).
// - locks-unavailable: the browser has no Web Locks, so two tabs could each
//   make a key.
export type DeviceKeyFailure =
  | 'signing-unavailable'
  | 'storage-unavailable'
  | 'locks-unavailable'

export type DeviceKeyResult =
  | { ok: true; key: DeviceKey }
  | { ok: false; reason: DeviceKeyFailure }

// Where the key is kept: a database of its own, with one store and one entry.
export const keyDatabase = 'fortymm-device-key'
export const keyStore = 'keys'
export const keyEntry = 'signing'

// The lock that makes key creation one at a time across every tab, worker
// and the service worker of the origin. The design runs key creation inside
// the journal's append lock (section 5.4); the journal will append under this
// same name.
export const appendLock = 'fortymm-journal-append'

const algorithm = { name: 'ECDSA', namedCurve: 'P-256' } as const
const signing = { name: 'ECDSA', hash: 'SHA-256' } as const

// This device's key: the kept one, or, if there is none, a new one, made and
// kept first. Two callers at once, in one page or in two tabs, get the same
// key: creation runs inside the append lock and looks again for a kept key
// once it holds it.
export async function deviceKey(): Promise<DeviceKeyResult> {
  if (globalThis.crypto?.subtle === undefined) return failure('signing-unavailable')
  if (globalThis.indexedDB === undefined) return failure('storage-unavailable')
  if (globalThis.navigator?.locks === undefined) return failure('locks-unavailable')

  let database: IDBDatabase
  try {
    database = await openKeyDatabase()
  } catch {
    return failure('storage-unavailable')
  }
  try {
    const kept = await readPair(database).catch(() => null)
    if (kept === null) return failure('storage-unavailable')
    if (kept !== undefined) return { ok: true, key: await keyOf(kept) }

    const made = await navigator.locks.request(appendLock, () =>
      keptOrMade(database),
    )
    return made.ok ? { ok: true, key: await keyOf(made.pair) } : made
  } finally {
    database.close()
  }
}

// Inside the lock: another caller may have made the key while this one
// waited for it.
async function keptOrMade(
  database: IDBDatabase,
): Promise<{ ok: true; pair: KeptPair } | { ok: false; reason: DeviceKeyFailure }> {
  let kept: KeptPair | undefined
  try {
    kept = await readPair(database)
  } catch {
    return failure('storage-unavailable')
  }
  if (kept !== undefined) return { ok: true, pair: kept }

  let pair: KeptPair
  try {
    pair = await crypto.subtle.generateKey(algorithm, false, ['sign', 'verify'])
  } catch {
    return failure('signing-unavailable')
  }
  try {
    await writePair(database, pair)
  } catch {
    return failure('storage-unavailable')
  }
  return { ok: true, pair }
}

async function keyOf(pair: KeptPair): Promise<DeviceKey> {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return {
    publicKey: compressedPublicKey(raw),
    sign: async (bytes) =>
      new Uint8Array(
        await crypto.subtle.sign(signing, pair.privateKey, bytes as BufferSource),
      ),
  }
}

// WebCrypto exports a P-256 public key uncompressed: 65 bytes, 04, then x and
// y. A record stores it compressed: 02 if y is even, 03 if odd, then x.
export function compressedPublicKey(uncompressed: Uint8Array): Uint8Array {
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
    throw new Error('compressedPublicKey: not an uncompressed P-256 public key')
  }
  const compressed = new Uint8Array(33)
  compressed[0] = (uncompressed[64] & 1) === 0 ? 0x02 : 0x03
  compressed.set(uncompressed.subarray(1, 33), 1)
  return compressed
}

// A signature from DeviceKey.sign in the form a record stores, by the core.
export function storedSignature(core: Core, raw: Uint8Array): Uint8Array {
  return core.signatureFromRaw(raw)
}

function failure(reason: DeviceKeyFailure): { ok: false; reason: DeviceKeyFailure } {
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

function readPair(database: IDBDatabase): Promise<KeptPair | undefined> {
  return new Promise((resolve, reject) => {
    const request = database
      .transaction(keyStore, 'readonly')
      .objectStore(keyStore)
      .get(keyEntry)
    request.onsuccess = () => resolve(request.result as KeptPair | undefined)
    request.onerror = () => reject(request.error)
  })
}

// Resolves once the key is on disk: a strict transaction where the browser
// offers one.
function writePair(database: IDBDatabase, pair: KeptPair): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(keyStore, 'readwrite', {
      durability: 'strict',
    })
    transaction.objectStore(keyStore).put(pair, keyEntry)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}
