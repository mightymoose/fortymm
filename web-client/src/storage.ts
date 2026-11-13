import type { Core } from 'fortymm-core/fortymm-core.mjs'
import { loadCore } from './core/load.ts'
import { appendLock } from './device-key.ts'

// The web client's storage of records, and of the users minted from them
// (design section 5, the Web row): IndexedDB, records in one store keyed by
// their id, written with strict durability inside the journal's append lock.
// Nothing else opens this database; the rest of the app sees the types below.
//
// The record is the source of truth: its signed bytes, kept as they are. A
// user is a copy of what a hello says, kept beside it so it can be read by
// player id, and always rebuildable from the records. A record and the user it
// mints are written in one transaction: there is never one without the other.

// A player this device knows of, as a hello introduced it. Ids and the key
// are lower-case hex.
export type User = {
  playerId: string
  accountId: string
  // The generated username (design 8.4), computed from the player id.
  username: string
  // The key the hello introduced: 33 bytes, compressed.
  publicKey: string
  // Only the server confirms a username. Nothing here syncs yet, so every
  // user is unconfirmed.
  unconfirmed: boolean
}

// Why storage did nothing. Neither keeps anything half-written.
// - storage-unavailable: IndexedDB is missing, or refused to open, read or
//   write (blocked storage, some private windows, a failed write).
// - locks-unavailable: the browser has no Web Locks, so the write could not
//   take the append lock.
// - core-unavailable: the shared core didn't load, so the record couldn't
//   be read. Nothing is stored.
// - not-a-hello: the record is damaged, its signature doesn't verify, or it
//   is of another kind. A hello is the only kind stored for now.
export type StorageFailure = 'storage-unavailable' | 'locks-unavailable'
export type StoreFailure = StorageFailure | 'core-unavailable' | 'not-a-hello'| 'not-a-hello'

export type StoreResult = { ok: true } | { ok: false; reason: StoreFailure }
export type LoadUserResult =
  | { ok: true; user: User | null }
  | { ok: false; reason: 'storage-unavailable' }

export const storageDatabase = 'fortymm-storage'
export const recordStore = 'records'
export const userStore = 'users'

// The suffix length of a generated username before any clash (design 8.4),
// as /health shows it.
const usernameSuffix = 4

// Keeps a hello, and the user it mints, on disk. Storing the same record
// again changes nothing. The record is read by the shared core (loadCore),
// never by parsing its bytes here.
export async function storeRecord(record: Uint8Array): Promise<StoreResult> {
  let core: Core
  try {
    core = await loadCore()
  } catch {
    return failure('core-unavailable')
  }
  const minted = mint(core, record)
  if (minted === null) return failure('not-a-hello')
  if (globalThis.indexedDB === undefined) return failure('storage-unavailable')
  if (globalThis.navigator?.locks === undefined) return failure('locks-unavailable')

  let database: IDBDatabase
  try {
    database = await openStorage()
  } catch {
    return failure('storage-unavailable')
  }
  try {
    await navigator.locks.request(appendLock, () => write(database, minted))
    return { ok: true }
  } catch {
    return failure('storage-unavailable')
  } finally {
    database.close()
  }
}

// The user with this player id (hex), or null when none is stored.
export async function loadUser(playerId: string): Promise<LoadUserResult> {
  if (globalThis.indexedDB === undefined) return failure('storage-unavailable')
  let database: IDBDatabase
  try {
    database = await openStorage()
  } catch {
    return failure('storage-unavailable')
  }
  try {
    const user = await read(database, playerId)
    return { ok: true, user: user ?? null }
  } catch {
    return failure('storage-unavailable')
  } finally {
    database.close()
  }
}

type Minted = { id: string; record: Uint8Array; user: User }

// What a hello says, by the core's getters; null for anything that isn't a
// hello whose signature verifies.
function mint(core: Core, record: Uint8Array): Minted | null {
  try {
    const introduced = core.introducedKey(record)
    if (introduced === null || !core.verify(record)) return null
    const playerId = core.signerOwnPlayerId(record)
    return {
      id: hex(core.id(record)),
      record,
      user: {
        playerId: hex(playerId),
        accountId: hex(core.signerAccountId(record)),
        username: core.username(playerId, usernameSuffix),
        publicKey: hex(introduced),
        unconfirmed: true,
      },
    }
  } catch {
    return null
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function failure<Reason>(reason: Reason): { ok: false; reason: Reason } {
  return { ok: false, reason }
}

function openStorage(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(storageDatabase, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(recordStore)
      request.result.createObjectStore(userStore)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('The storage database is blocked'))
  })
}

function read(database: IDBDatabase, playerId: string): Promise<User | undefined> {
  return new Promise((resolve, reject) => {
    const request = database
      .transaction(userStore, 'readonly')
      .objectStore(userStore)
      .get(playerId)
    request.onsuccess = () => resolve(request.result as User | undefined)
    request.onerror = () => reject(request.error)
  })
}

// One transaction for the record and its user, resolved once both are on
// disk (strict durability where the browser offers it). If either put fails,
// the transaction is aborted, and neither is kept.
function write(database: IDBDatabase, { id, record, user }: Minted): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([recordStore, userStore], 'readwrite', {
      durability: 'strict',
    })
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('Aborted'))
    try {
      transaction.objectStore(recordStore).put(record, id)
      transaction.objectStore(userStore).put(user, user.playerId)
    } catch (error) {
      transaction.abort()
      reject(error)
    }
  })
}
