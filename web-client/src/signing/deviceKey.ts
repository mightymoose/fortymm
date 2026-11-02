import type { ApiClient } from '../api/client'
import { hex } from './bytes'
import { equalBytes } from './cbor'
import { coseKey, keyId, registrationProof } from './cose'
import type { Signer } from './envelope'
import { fromBase64url } from './text'

// This browser's signing key. The private half never leaves WebCrypto. The
// public half is kept beside it, so the key never needs exporting again.
type DeviceKey = {
  privateKey: CryptoKey
  coseKey: Uint8Array<ArrayBuffer>
  kid: Uint8Array<ArrayBuffer>
}

// One record under a fixed key. It holds no account and no "registered"
// flag: every session answer registers the key again, which the API answers
// 200 for a key the account already owns. So a switched account, a revoked
// key and a lost key each heal with one request, and no local state drifts.
const DATABASE = 'fortymm-signing'
const STORE = 'device-key'
const RECORD = 'device'
const LABEL = 'Web browser'

const ECDSA = { name: 'ECDSA', hash: 'SHA-256' }

// Registers this browser's key to `accountId`, making the key first if
// there is none. A key that is revoked, or that another account owns, is
// replaced, and the new one registered, once. Any other failure, such as no
// network or no IndexedDB, leaves it for the next session answer. It never
// throws.
export async function registerDeviceKey(api: ApiClient, accountId: string): Promise<void> {
  try {
    const key = (await storedKey()) ?? (await createKey())
    if ((await register(api, key, accountId)) === 'kept') return
    const replacement = await replaceKey(key.kid)
    if (replacement) await register(api, replacement, accountId)
  } catch {
    // The next session answer tries again.
  }
}

async function register(
  api: ApiClient,
  key: DeviceKey,
  accountId: string,
): Promise<'kept' | 'replace'> {
  const proof = await registrationProof(signer(key), accountId)
  const { data, response } = await api.POST('/v1/account/signing-keys', {
    body: { public_key: hex(key.coseKey), proof: hex(proof), label: LABEL },
  })
  return response.status === 409 || data?.data.revoked_at ? 'replace' : 'kept'
}

// A signer with this browser's key, or null if it has none.
export async function signWithDeviceKey(): Promise<Signer | null> {
  const key = await storedKey()
  return key && signer(key)
}

// The id of this browser's key, in hex, or null if it has none or storage
// fails. A sign-out sends it, so it never fails over the key.
export async function deviceKeyId(): Promise<string | null> {
  try {
    const key = await storedKey()
    return key && hex(key.kid)
  } catch {
    return null
  }
}

// Deletes the key, if it is still the one with id `kidHex`. It never throws.
export async function forgetKey(kidHex: string): Promise<void> {
  try {
    await update((stored, store) => {
      if (stored && hex(stored.kid) === kidHex) store.delete(RECORD)
    })
  } catch {
    // Storage that fails holds no key to forget.
  }
}

function signer(key: DeviceKey): Signer {
  return {
    kid: key.kid,
    sign: async (data) => new Uint8Array(await crypto.subtle.sign(ECDSA, key.privateKey, data)),
  }
}

async function generateKey(): Promise<DeviceKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
  ])
  const { x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const encoded = coseKey(fromBase64url(x!), fromBase64url(y!))
  return { privateKey: pair.privateKey, coseKey: encoded, kid: await keyId(encoded) }
}

// Stores a new key, unless another tab stored one first. Then that one is
// this browser's key.
async function createKey(): Promise<DeviceKey> {
  const fresh = await generateKey()
  return update((stored, store) => {
    if (stored) return stored
    store.put(fresh, RECORD)
    return fresh
  })
}

// Replaces the key with id `oldKid`. If the stored key is another one,
// because another tab replaced it, that one stays. If there is none, because
// a sign-out deleted it, none is made.
async function replaceKey(oldKid: Uint8Array<ArrayBuffer>): Promise<DeviceKey | null> {
  const fresh = await generateKey()
  return update((stored, store) => {
    if (!stored || !equalBytes(stored.kid, oldKid)) return stored
    store.put(fresh, RECORD)
    return fresh
  })
}

async function storedKey(): Promise<DeviceKey | null> {
  return update((stored) => stored)
}

// Runs `change` on the stored key inside one readwrite transaction, so the
// read and the write it decides on are atomic across tabs. No await may
// come between them, or the transaction commits.
async function update<T>(
  change: (stored: DeviceKey | null, store: IDBObjectStore) => T,
): Promise<T> {
  const database = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      let result: T
      const read = store.get(RECORD)
      read.onsuccess = () => {
        result = change(parse(read.result), store)
      }
      transaction.oncomplete = () => resolve(result)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

// Anything else in the record, such as from a broken write, counts as no
// key, and the next registration makes a new one.
function parse(record: unknown): DeviceKey | null {
  if (typeof record !== 'object' || record === null) return null
  const { privateKey, coseKey, kid } = record as Partial<DeviceKey>
  const bytes = (value: unknown, length: number) =>
    ArrayBuffer.isView(value) && value.byteLength === length
  return privateKey && bytes(coseKey, 75) && bytes(kid, 32)
    ? { privateKey, coseKey: coseKey!, kid: kid! }
    : null
}
