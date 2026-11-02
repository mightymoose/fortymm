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

// The key is one record under a fixed key. It holds no account and no
// "registered" flag: every session answer registers the key again, which the
// API answers 200 for a key the account already owns. So a switched account,
// a revoked key and a lost key each heal with one request, and no local state
// drifts.
const DATABASE = 'fortymm-signing'
const STORE = 'device-key'
const RECORD = 'device'
const LABEL = 'Web browser'

// A key that a registration makes during a sign-out, in any tab, could stay
// live on the account that signs out. So a sign-out leaves a record beside
// the key, and every key write checks it in the same transaction: no key is
// stored while a sign-out runs, nor one whose making started before the
// last sign-out did. `since` is when the running sign-out started. A tab
// closed mid-logout leaves it set, so after SIGN_OUT_MS it no longer counts.
const SIGN_OUT = 'sign-out'
export const SIGN_OUT_MS = 60_000
type SignOut = { count: number; since: number | null }
type Stored = { key: DeviceKey | null; signOut: SignOut }

const ECDSA = { name: 'ECDSA', hash: 'SHA-256' }

// Registers this browser's key to `accountId`, making the key first if
// there is none. A key that is revoked, or that another account owns, is
// replaced, and the new one registered, once. Any other failure, such as no
// network or no IndexedDB, leaves it for the next session answer. It never
// throws.
export async function registerDeviceKey(api: ApiClient, accountId: string): Promise<void> {
  try {
    const { key: stored, signOut } = await update((current) => current)
    const key = stored ?? (await createKey(signOut.count))
    if (!key) return
    if ((await register(api, key, accountId)) === 'kept') return
    const replacement = await replaceKey(key.kid, signOut.count)
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

// This browser's key, taken out of storage before a sign-out sends its id,
// with the sign-out record set. `id` is null if there is no key or storage
// fails, so a sign-out never fails over the key. After the logout, `release`
// ends the sign-out: the session is gone, so no later key can be live on the
// old account. `restore` ends it too if the logout fails, and puts the key
// back unless another key has been stored meanwhile.
export type TakenKey = { id: string | null; release(): Promise<void>; restore(): Promise<void> }

export async function takeKey(): Promise<TakenKey> {
  const taken = await update(({ key, signOut }, store) => {
    if (key) store.delete(RECORD)
    const mark: SignOut = { count: signOut.count + 1, since: Date.now() }
    store.put(mark, SIGN_OUT)
    return { key, mark }
  }).catch(() => null)
  const end = (putBack: boolean) =>
    update(({ key, signOut }, store) => {
      if (!taken) return
      if (signOut.count === taken.mark.count) store.put({ ...signOut, since: null }, SIGN_OUT)
      if (putBack && taken.key && !key) store.put(taken.key, RECORD)
    }).catch(() => {
      // A sign-out record left set stops counting after SIGN_OUT_MS.
    })
  return {
    id: taken?.key ? hex(taken.key.kid) : null,
    release: () => end(false),
    restore: () => end(true),
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

// Whether a key may be stored now by a write whose making started when the
// sign-out count was `started`.
function mayStore(signOut: SignOut, started: number): boolean {
  const signingOut = signOut.since !== null && Date.now() - signOut.since < SIGN_OUT_MS
  return !signingOut && signOut.count === started
}

// Stores a new key, unless another tab stored one first. Then that one is
// this browser's key. During or after a sign-out that started meanwhile, it
// stores none.
async function createKey(started: number): Promise<DeviceKey | null> {
  const fresh = await generateKey()
  return update(({ key, signOut }, store) => {
    if (key || !mayStore(signOut, started)) return key
    store.put(fresh, RECORD)
    return fresh
  })
}

// Replaces the key with id `oldKid`. If the stored key is another one,
// because another tab replaced it, that one stays. If there is none, because
// a sign-out took it, none is made.
async function replaceKey(
  oldKid: Uint8Array<ArrayBuffer>,
  started: number,
): Promise<DeviceKey | null> {
  const fresh = await generateKey()
  return update(({ key, signOut }, store) => {
    if (!key || !mayStore(signOut, started) || !equalBytes(key.kid, oldKid)) return key
    store.put(fresh, RECORD)
    return fresh
  })
}

async function storedKey(): Promise<DeviceKey | null> {
  return update(({ key }) => key)
}

// Runs `change` on the stored key and sign-out record inside one readwrite
// transaction, so the read and the write it decides on are atomic across
// tabs. No await may come between them, or the transaction commits.
async function update<T>(change: (stored: Stored, store: IDBObjectStore) => T): Promise<T> {
  const database = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      let result: T
      const key = store.get(RECORD)
      const signOut = store.get(SIGN_OUT)
      // Requests in one transaction succeed in order, so the key is read.
      signOut.onsuccess = () => {
        result = change({ key: parse(key.result), signOut: parseSignOut(signOut.result) }, store)
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

function parseSignOut(record: unknown): SignOut {
  if (typeof record !== 'object' || record === null) return { count: 0, since: null }
  const { count, since } = record as Partial<SignOut>
  return {
    count: typeof count === 'number' ? count : 0,
    since: typeof since === 'number' ? since : null,
  }
}
