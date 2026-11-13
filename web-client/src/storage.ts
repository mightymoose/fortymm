import type { Core } from 'fortymm-core/fortymm-core.mjs'
import { loadCore } from './core/load.ts'

// The web client's storage of records, and of the users minted from them
// (design section 5, the Web row): IndexedDB, records in one store keyed by
// their id, written with strict durability inside the journal's append lock.
// Nothing else opens this database; the rest of the app sees the types below.
//
// The record is the source of truth: its signed bytes, kept as they are. A
// user is a copy of what a hello says, kept beside it so it can be read by
// player id, and always rebuildable from the records. A record and the user it
// mints are written in one transaction: there is never one without the other.
//
// Which stored user is this device's own is kept too: a pointer, the "me"
// entry, holding that user's player id. It is written in the same
// transaction as the user it points to (or, for a user already stored, in a
// transaction that finds it there), so there is never a pointer to a user
// that isn't stored. loadMe reads it and the user in one transaction: no key,
// no core.

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
export type StoreFailure = StorageFailure | 'core-unavailable' | 'not-a-hello'

export type StoreResult = { ok: true } | { ok: false; reason: StoreFailure }
export type LoadUserResult =
  | { ok: true; user: User | null }
  | { ok: false; reason: 'storage-unavailable' }

// The journal's append lock (design 5.4): one writer at a time across every
// tab, worker and the service worker of the origin. Every write here, and the
// device key's creation (withDeviceKey, device-key.ts), runs inside it. Web
// Locks are not re-entrant: code that holds it writes through heldStore.
export const appendLock = 'fortymm-journal-append'

// - no-user: no user with that player id is stored, so it can't be this
//   device's; nothing was written.
export type StoreMeResult =
  | { ok: true }
  | { ok: false; reason: 'storage-unavailable' | 'no-user' }

// The storage functions, for code that already holds the append lock: only
// withDeviceKey's callback, the one place that knows which user is this
// device's.
// - storeRecord(record, { me: true }) also makes the user the record mints
//   this device's own, in the same transaction.
// - storeMe(playerId) makes an already stored user this device's own (a
//   device whose user was stored before the pointer existed). It writes
//   nothing when the pointer already says so.
export type Store = {
  storeRecord(record: Uint8Array, options?: { me: true }): Promise<StoreResult>
  storeMe(playerId: string): Promise<StoreMeResult>
  loadUser(playerId: string): Promise<LoadUserResult>
}

export const storageDatabase = 'fortymm-storage'
// 1: records and users. 2: the me store.
const storageVersion = 2
export const recordStore = 'records'
export const userStore = 'users'
// One entry, meEntry: the player id (hex) of this device's own user.
export const meStore = 'me'
export const meEntry = 'user'

// How long opening waits while a connection in another tab, at an older
// version, keeps the upgrade from running, before giving up as
// storage-unavailable. Connections here close on versionchange, and every
// operation closes its own, so a wait is short; the bound is for a tab that
// never lets go.
const blockedBound = 5_000

// The suffix length of a generated username before any clash (design 8.4),
// as /health shows it.
const usernameSuffix = 4

// Keeps a hello, and the user it mints, on disk. Storing the same record
// again changes nothing. The record is read by the shared core (loadCore),
// never by parsing its bytes here. Takes the append lock to write.
export function storeRecord(record: Uint8Array): Promise<StoreResult> {
  return store(record, false, (write) => navigator.locks.request(appendLock, write))
}

// This device's own user, or null when none is marked (no first launch yet,
// or it failed). One read, taking no lock, and no core: a screen can show
// the user at once.
export async function loadMe(): Promise<LoadUserResult> {
  return reading((database) => readMe(database))
}

// The same storeRecord and loadUser, taking no lock of their own: only for
// code that holds the append lock already, which is withDeviceKey's callback
// (device-key.ts) and nothing else. There, the public storeRecord would wait
// for the lock its caller holds, for ever. Never keep it past the callback.
export const heldStore: Store = {
  storeRecord: (record, options) =>
    store(record, options?.me === true, (write) => write()),
  storeMe: (playerId) => storeMe(playerId),
  loadUser: (playerId) => loadUser(playerId),
}

// storeRecord's body, with the write run by underLock: inside the append
// lock it takes, or directly when the caller holds it.
async function store(
  record: Uint8Array,
  me: boolean,
  underLock: (write: () => Promise<void>) => Promise<void>,
): Promise<StoreResult> {
  let core: Core
  try {
    core = await loadCore()
  } catch {
    return failure('core-unavailable')
  }
  // A tight copy of the caller's bytes: what is verified is what is kept,
  // whatever the caller does with its array while this waits for the lock.
  const minted = mint(core, record.slice())
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
    await underLock(() => write(database, minted, me))
    return { ok: true }
  } catch {
    return failure('storage-unavailable')
  } finally {
    database.close()
  }
}

// The user with this player id (hex), or null when none is stored.
export async function loadUser(playerId: string): Promise<LoadUserResult> {
  return reading((database) => read(database, playerId))
}

// heldStore's storeMe: only with the append lock held.
async function storeMe(playerId: string): Promise<StoreMeResult> {
  if (globalThis.indexedDB === undefined) return failure('storage-unavailable')
  let database: IDBDatabase
  try {
    database = await openStorage()
  } catch {
    return failure('storage-unavailable')
  }
  try {
    return (await pointAt(database, playerId)) ? { ok: true } : failure('no-user')
  } catch {
    return failure('storage-unavailable')
  } finally {
    database.close()
  }
}

// Opens the database, runs one read, and closes it.
async function reading(
  read: (database: IDBDatabase) => Promise<User | undefined>,
): Promise<LoadUserResult> {
  if (globalThis.indexedDB === undefined) return failure('storage-unavailable')
  let database: IDBDatabase
  try {
    database = await openStorage()
  } catch {
    return failure('storage-unavailable')
  }
  try {
    const user = await read(database)
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

// Opens the database at storageVersion, upgrading it from any older one
// without touching what it holds: a device at version 1 keeps its records
// and users, and gets an empty me store (its first launch then fills it).
// The connection closes itself when another tab needs a newer version, so
// it never holds an upgrade up.
function openStorage(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(storageDatabase, storageVersion)
    let gaveUp = false
    let blocked: ReturnType<typeof setTimeout> | undefined
    request.onupgradeneeded = (event) => {
      const database = request.result
      if (event.oldVersion < 1) {
        database.createObjectStore(recordStore)
        database.createObjectStore(userStore)
      }
      if (event.oldVersion < 2) database.createObjectStore(meStore)
    }
    request.onsuccess = () => {
      clearTimeout(blocked)
      const database = request.result
      if (gaveUp) {
        database.close()
        return
      }
      database.onversionchange = () => database.close()
      resolve(database)
    }
    request.onerror = () => {
      clearTimeout(blocked)
      reject(request.error)
    }
    // Another tab holds an older version open. Wait for it to let go, up to
    // blockedBound; a connection that opens after that is closed at once.
    request.onblocked = () => {
      blocked = setTimeout(() => {
        gaveUp = true
        reject(new Error('The storage database is blocked'))
      }, blockedBound)
    }
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

// The pointer, then the user it names, in one transaction.
function readMe(database: IDBDatabase): Promise<User | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([meStore, userStore], 'readonly')
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('Aborted'))
    const pointer = transaction.objectStore(meStore).get(meEntry)
    pointer.onsuccess = () => {
      if (pointer.result === undefined) return resolve(undefined)
      const user = transaction.objectStore(userStore).get(pointer.result as string)
      user.onsuccess = () => resolve(user.result as User | undefined)
    }
  })
}

// Points the me entry at the stored user with this player id, in one
// transaction that finds the user there: true once it points there (written
// now or already), false when no such user is stored (nothing written).
function pointAt(database: IDBDatabase, playerId: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([meStore, userStore], 'readwrite', {
      durability: 'strict',
    })
    let pointed = false
    transaction.oncomplete = () => resolve(pointed)
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('Aborted'))
    const user = transaction.objectStore(userStore).getKey(playerId)
    user.onsuccess = () => {
      if (user.result === undefined) return
      pointed = true
      const me = transaction.objectStore(meStore)
      const pointer = me.get(meEntry)
      pointer.onsuccess = () => {
        if (pointer.result !== playerId) me.put(playerId, meEntry)
      }
    }
  })
}

// One transaction for the record and its user, resolved once both are on
// disk (strict durability where the browser offers it). If either put fails,
// the transaction is aborted, and neither is kept.
//
// A record whose id is already kept is not written again. An id is the hash
// of the body alone, and signatures are randomized, so one body signed twice
// is two valid records with one id: the same record (design section 7), and
// the first one kept stays. The user is put either way; it is minted from
// the body, so it is the same row.
//
// With me, the me entry is pointed at the user in the same transaction: if
// any put fails, none of the three is kept.
function write(
  database: IDBDatabase,
  { id, record, user }: Minted,
  me: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stores = me ? [recordStore, userStore, meStore] : [recordStore, userStore]
    const transaction = database.transaction(stores, 'readwrite', {
      durability: 'strict',
    })
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('Aborted'))
    try {
      const records = transaction.objectStore(recordStore)
      const kept = records.getKey(id)
      kept.onsuccess = () => {
        if (kept.result === undefined) records.put(record, id)
      }
      transaction.objectStore(userStore).put(user, user.playerId)
      if (me) transaction.objectStore(meStore).put(user.playerId, meEntry)
    } catch (error) {
      transaction.abort()
      reject(error)
    }
  })
}
