import type { Core } from 'fortymm-core/fortymm-core.mjs'
import { announce } from './changes.ts'
import { loadCore } from './core/load.ts'
import { bestOfs, type BestOf } from './scoring/scoring.ts'
import type { MatchSummary, StoredMatch, Unavailable } from './stores/match-source.ts'

// The web client's storage of records, and of what is computed from them
// (design section 5, the Web row): IndexedDB, written with strict durability
// inside the journal's append lock. Nothing else opens this database; the
// rest of the app sees the types below.
//
// Two groups of stores, as the design's tables have (section 7.4):
//
// - The journal, the only truth, only ever added to: `records`, each
//   record's signed bytes keyed by its id, and `journal`, one row per record
//   in the order it entered (its `seq`), with its kind and the match it is
//   about read out of the bytes by the core.
// - Views, computed from the journal and rebuildable from it: `matches`, one
//   row per match, what the core's matchState gives for that match's kept
//   records (writeView, the one function that writes it); and `users`, what
//   a hello says, kept beside it (outside rebuildViews for now).
//
// No typed name is kept (the user, 2026-11-16: "I don't actually care about
// the typed names at all"): a match is what its records say, and its
// opponent shows as "Anonymous". `me` is a pointer: which stored user is
// this device's own.
//
// A record, its journal row and every row computed from it are written in
// one transaction: there is never one without the others.
//
// A delete or an upgrade of the database waits for every open connection to
// close, and every open after it waits for the delete. So no connection is
// kept open while waiting for the append lock (storeRecord and rebuildViews
// open theirs once they hold it), and every connection closes when one is
// asked for (onversionchange): otherwise a call waiting for the lock with its
// connection open would hold back a delete that the lock's holder is itself
// queued behind, and every tab would wait for ever.

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

// Why storage did nothing. None keeps anything half-written.
// - storage-unavailable: IndexedDB is missing, or refused to open, read or
//   write (blocked storage, some private windows, a failed write).
// - locks-unavailable: the browser has no Web Locks, so the write could not
//   take the append lock.
// - core-unavailable: the shared core didn't load, so the record couldn't
//   be read. Nothing is stored.
// - not-a-hello: storeRecord's record is damaged, its signature doesn't
//   verify, or it is of another kind.
// - record-refused: one of append's records is damaged, its signature
//   doesn't verify, or it is of a kind append doesn't keep (only `player`,
//   `match` and `score`). Nothing of the append is stored.
export type StorageFailure = 'storage-unavailable' | 'locks-unavailable'
export type StoreFailure = StorageFailure | 'core-unavailable' | 'not-a-hello'
export type AppendFailure = StorageFailure | 'core-unavailable' | 'record-refused'

export type StoreResult = { ok: true } | { ok: false; reason: StoreFailure }
export type AppendResult = { ok: true } | { ok: false; reason: AppendFailure }
export type LoadUserResult =
  | { ok: true; user: User | null }
  | { ok: false; reason: 'storage-unavailable' }
export type LoadMatchResult = { ok: true; match: StoredMatch | null } | Unavailable
export type LoadMatchesResult = { ok: true; matches: MatchSummary[] } | Unavailable
export type RebuildResult =
  | { ok: true }
  | { ok: false; reason: 'storage-unavailable' | 'core-unavailable' | 'locks-unavailable' }

// A match as kept, with the ids (hex) of the score records current for each
// game: what a save names as replaced (core/FORMAT.md, section 16). Only the
// held store gives it, to code deciding inside the lock what to write.
export type StoredMatchWithCurrent = StoredMatch & { readonly current: string[][] }
export type LoadMatchWithCurrentResult =
  | { ok: true; match: StoredMatchWithCurrent | null }
  | Unavailable

// The kinds of record kept: hellos through storeRecord, the rest through
// append.
export type KeptKind = 'hello' | 'player' | 'match' | 'score'

// A row of the journal: a record that entered, in order. `match` is the id of
// the match a `match` record is (its own id) or a `score` record is about,
// null for other kinds. `state` is `held` until sync exists.
export type JournalRow = {
  seq: number
  id: string
  kind: KeptKind
  match: string | null
  state: 'held'
}

// A row of the `matches` view: exactly what core.matchState gives for the
// match's kept records, in hex, and `seq`, the journal number of its `match`
// record (newest first is by it). Nothing else: nothing from `me`, nothing a
// person typed.
export type MatchView = {
  matchId: string
  creator: string
  sides: [string[], string[]]
  terms: { bestOf: number; rated: boolean } | null
  games: ([number, number] | null)[]
  current: string[][]
  seq: number
}

// The journal's append lock (design 5.4): one writer at a time across every
// tab, worker and the service worker of the origin. Every write here, and the
// device key's creation (withDeviceKey, device-key.ts), runs inside it. Web
// Locks are not re-entrant: code that holds it writes through heldStore.
export const appendLock = 'fortymm-journal-append'

// The storage functions, for code that already holds the append lock: only
// withDeviceKey's callback, the one place that knows which user is this
// device's and the one place records are made. There, storeRecord(record,
// { me: true }) also makes the user the record mints this device's own, in
// the same transaction; append keeps records this device made; loadMatch
// reads a match with its current entries, for deciding what to make.
export type Store = {
  storeRecord(record: Uint8Array, options?: { me: true }): Promise<StoreResult>
  loadUser(playerId: string): Promise<LoadUserResult>
  append(records: Uint8Array[]): Promise<AppendResult>
  loadMatch(matchId: string): Promise<LoadMatchWithCurrentResult>
}

export const storageDatabase = 'fortymm-storage'
export const recordStore = 'records'
export const journalStore = 'journal'
export const matchViewStore = 'matches'
export const userStore = 'users'
// One entry, meEntry: the player id (hex) of this device's own user.
export const meStore = 'me'
export const meEntry = 'user'
// The journal's indexes: by record id (unique) and by match id.
export const journalById = 'id'
export const journalByMatch = 'match'

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

// The same storeRecord and loadUser, append and the held loadMatch, taking no
// lock of their own: only for code that holds the append lock already, which
// is withDeviceKey's callback (device-key.ts) and nothing else. There, the
// public storeRecord would wait for the lock its caller holds, for ever.
// Never keep it past the callback.
export const heldStore: Store = {
  storeRecord: (record, options) =>
    store(record, options?.me === true, (write) => write()),
  loadUser: (playerId) => loadUser(playerId),
  append: (records) => append(records),
  loadMatch: (matchId) =>
    reading((database) => readMatch(database, matchId, true)) as Promise<
      LoadMatchWithCurrentResult
    >,
}

// The match with this id (hex), from its view row, or null when no match
// with this id is kept, or its terms can't be read or aren't a length this
// app knows. No lock, no core: one read.
export async function loadMatch(matchId: string): Promise<LoadMatchResult> {
  return reading((database) => readMatch(database, matchId, false))
}

// Every match kept, newest first by the journal number of its `match`
// record. Matches whose terms can't be read, or aren't a length this app
// knows, are left out. No lock, no core.
export async function loadMatches(): Promise<LoadMatchesResult> {
  return reading((database) => readMatches(database))
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

  try {
    // Opened once the lock is held, never while waiting for it.
    await underLock(() => withDatabase((database) => write(database, minted, me)))
  } catch {
    return failure('storage-unavailable')
  }
  // The transaction has completed: every hello stores a user (and, with me,
  // the pointer), so this device's account may have changed. Announced to
  // this tab and the others (src/changes.ts), which read again what their
  // pages show. announce never throws.
  announce({ account: true, matches: [], revision: 0 })
  return { ok: true }
}

// A record append keeps, as the core reads it.
type Entering = {
  id: string
  record: Uint8Array
  kind: 'player' | 'match' | 'score'
  match: string | null
}

// Keeps records this device made, in the order given, in one transaction:
// each record not kept already, its journal row, the view row of every match
// they touch, computed again by the core (writeView). All or nothing. Every
// record is read and verified by the core before storage is opened; one that
// fails refuses the whole append. Announces the matches touched once the
// transaction has completed; a write that keeps nothing new announces
// nothing.
async function append(records: Uint8Array[]): Promise<AppendResult> {
  let core: Core
  try {
    core = await loadCore()
  } catch {
    return failure('core-unavailable')
  }
  const entering: Entering[] = []
  for (const record of records) {
    const read = enter(core, record.slice())
    if (read === null) return failure('record-refused')
    entering.push(read)
  }
  if (globalThis.indexedDB === undefined) return failure('storage-unavailable')

  let database: IDBDatabase
  try {
    database = await openStorage()
  } catch {
    return failure('storage-unavailable')
  }
  let written: { any: boolean; matches: string[] }
  try {
    written = await writeRecords(database, core, entering)
  } catch {
    return failure('storage-unavailable')
  } finally {
    database.close()
  }
  if (written.any) announce({ account: false, matches: written.matches, revision: 0 })
  return { ok: true }
}

// What the core reads of a record append may keep; null for anything else.
function enter(core: Core, record: Uint8Array): Entering | null {
  try {
    const kind = core.kind(record)
    if (kind !== 'player' && kind !== 'match' && kind !== 'score') return null
    if (!core.verify(record)) return null
    const id = hex(core.id(record))
    if (kind === 'match') return { id, record, kind, match: id }
    if (kind === 'score') {
      const scored = core.scoredMatch(record)
      if (scored === null) return null
      return { id, record, kind, match: hex(scored) }
    }
    return { id, record, kind, match: null }
  } catch {
    return null
  }
}

// append's transaction. Resolves once it has completed, with whether any
// record was new and the ids of the matches whose records changed.
async function writeRecords(
  database: IDBDatabase,
  core: Core,
  entering: Entering[],
): Promise<{ any: boolean; matches: string[] }> {
  const transaction = database.transaction(
    [recordStore, journalStore, matchViewStore],
    'readwrite',
    { durability: 'strict' },
  )
  const done = completion(transaction)
  const touched = new Set<string>()
  let any = false
  try {
    const records = transaction.objectStore(recordStore)
    const journal = transaction.objectStore(journalStore)
    const seen = new Set<string>()
    for (const { id, record, kind, match } of entering) {
      // A record is kept once, by id: the same body signed again is the
      // same record, and the first one kept stays.
      if (seen.has(id)) continue
      seen.add(id)
      if ((await request(records.getKey(id))) !== undefined) continue
      records.put(record, id)
      journal.add({ id, kind, match, state: 'held' })
      any = true
      if (match !== null) touched.add(match)
    }
    for (const matchId of touched) await writeView(transaction, core, matchId)
  } catch (error) {
    abort(transaction)
    await done.catch(() => {})
    throw error
  }
  await done
  return { any, matches: [...touched] }
}

// The one function that writes a view row. Reads the match's records by the
// journal's match index, hands them to the core, and puts what it gives in
// `matches` under the match id, with the journal number of the match record;
// with no match record kept yet (design L2), there is no row. Runs inside the
// caller's transaction: append's, so a view is never behind its records, and
// rebuildViews'. The core is synchronous, so the transaction stays open.
async function writeView(
  transaction: IDBTransaction,
  core: Core,
  matchId: string,
): Promise<void> {
  const rows = (await request(
    transaction.objectStore(journalStore).index(journalByMatch).getAll(matchId),
  )) as JournalRow[]
  const records = transaction.objectStore(recordStore)
  const kept = (await Promise.all(
    rows.map(({ id }) => request(records.get(id))),
  )) as Uint8Array[]
  const state = core.matchState(kept)
  const views = transaction.objectStore(matchViewStore)
  const matchRow = rows.find(({ kind }) => kind === 'match')
  if (state === null || matchRow === undefined) {
    views.delete(matchId)
    return
  }
  const view: MatchView = {
    matchId: hex(state.matchId),
    creator: hex(state.creator),
    sides: [state.sides[0].map(hex), state.sides[1].map(hex)],
    terms: state.terms === null ? null : { bestOf: state.terms.bestOf, rated: state.terms.rated },
    games: state.games.map((game) => (game === null ? null : [game[0], game[1]])),
    current: state.current.map((ids) => ids.map(hex)),
    seq: matchRow.seq,
  }
  views.put(view, matchId)
}

// Drops every row of the `matches` view and writes it again from the journal
// alone, by writeView, in one transaction inside the append lock. The rows
// come back equal
// to those kept as records arrived, under the same keys: a view row is a
// function of the set of the match's records and its match record's journal
// number. Announces that any match may have changed.
export async function rebuildViews(): Promise<RebuildResult> {
  let core: Core
  try {
    core = await loadCore()
  } catch {
    return failure('core-unavailable')
  }
  if (globalThis.indexedDB === undefined) return failure('storage-unavailable')
  if (globalThis.navigator?.locks === undefined) return failure('locks-unavailable')
  try {
    // Opened once the lock is held, never while waiting for it.
    await navigator.locks.request(appendLock, () =>
      withDatabase((database) => rebuild(database, core)),
    )
  } catch {
    return failure('storage-unavailable')
  }
  announce({ account: false, matches: 'all', revision: 0 })
  return { ok: true }
}

async function rebuild(database: IDBDatabase, core: Core): Promise<void> {
  const transaction = database.transaction(
    [recordStore, journalStore, matchViewStore],
    'readwrite',
    { durability: 'strict' },
  )
  const done = completion(transaction)
  try {
    transaction.objectStore(matchViewStore).clear()
    const matchIds = await uniqueKeys(
      transaction.objectStore(journalStore).index(journalByMatch),
    )
    for (const matchId of matchIds) await writeView(transaction, core, matchId)
  } catch (error) {
    abort(transaction)
    await done.catch(() => {})
    throw error
  }
  await done
}

// Every distinct key of an index, in order. Rows with no match (null) are not
// in the index.
function uniqueKeys(index: IDBIndex): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const keys: string[] = []
    const cursor = index.openKeyCursor(null, 'nextunique')
    cursor.onsuccess = () => {
      if (cursor.result === null) return resolve(keys)
      keys.push(cursor.result.key as string)
      cursor.result.continue()
    }
    cursor.onerror = () => reject(cursor.error)
  })
}

// A view row as the app reads a match; null when its terms can't be read or
// its best of isn't a length this app knows. Nothing is derived here: the
// view holds what the core computed.
function storedMatch(
  view: MatchView,
  withCurrent: boolean,
): StoredMatch | StoredMatchWithCurrent | null {
  if (view.terms === null || !isBestOf(view.terms.bestOf)) return null
  const match: StoredMatch = {
    matchId: view.matchId,
    bestOf: view.terms.bestOf,
    rated: view.terms.rated,
    games: view.games,
  }
  return withCurrent ? { ...match, current: view.current } : match
}

function isBestOf(bestOf: number): bestOf is BestOf {
  return (bestOfs as readonly number[]).includes(bestOf)
}

// The view row of one match.
async function readMatch(
  database: IDBDatabase,
  matchId: string,
  withCurrent: boolean,
): Promise<{ ok: true; match: StoredMatch | null }> {
  const view = (await request(
    database.transaction(matchViewStore, 'readonly').objectStore(matchViewStore).get(matchId),
  )) as MatchView | undefined
  return { ok: true, match: view === undefined ? null : storedMatch(view, withCurrent) }
}

// Every view row, newest first.
async function readMatches(
  database: IDBDatabase,
): Promise<{ ok: true; matches: MatchSummary[] }> {
  const views = (await request(
    database.transaction(matchViewStore, 'readonly').objectStore(matchViewStore).getAll(),
  )) as MatchView[]
  const matches = views
    .map((view) => ({ view, match: storedMatch(view, false) }))
    .filter((row): row is { view: MatchView; match: StoredMatch } => row.match !== null)
    .sort((a, b) => b.view.seq - a.view.seq)
    .map(({ match }) => ({
      matchId: match.matchId,
      bestOf: match.bestOf,
      rated: match.rated,
    }))
  return { ok: true, matches }
}

// The user with this player id (hex), or null when none is stored.
export async function loadUser(playerId: string): Promise<LoadUserResult> {
  return reading(async (database) => ({
    ok: true,
    user: (await read(database, playerId)) ?? null,
  }))
}

// Opens the database, runs one read, and closes it. Any failure is
// storage-unavailable.
async function reading<Answer>(
  read: (database: IDBDatabase) => Promise<Answer>,
): Promise<Answer | { ok: false; reason: 'storage-unavailable' }> {
  if (globalThis.indexedDB === undefined) return failure('storage-unavailable')
  let database: IDBDatabase
  try {
    database = await openStorage()
  } catch {
    return failure('storage-unavailable')
  }
  try {
    return await read(database)
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

// Opens the database, runs work on it, and closes it, whatever work does.
async function withDatabase<T>(work: (database: IDBDatabase) => Promise<T>): Promise<T> {
  const database = await openStorage()
  try {
    return await work(database)
  } finally {
    database.close()
  }
}

// Every connection closes as soon as another asks to delete or upgrade the
// database (onversionchange): a transaction it has started still finishes,
// and one it starts after fails, as storage-unavailable. Open with
// withDatabase or reading, inside the lock where the call takes it.
function openStorage(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(storageDatabase, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      database.createObjectStore(recordStore)
      const journal = database.createObjectStore(journalStore, {
        keyPath: 'seq',
        autoIncrement: true,
      })
      journal.createIndex(journalById, 'id', { unique: true })
      journal.createIndex(journalByMatch, 'match')
      database.createObjectStore(matchViewStore)
      database.createObjectStore(userStore)
      database.createObjectStore(meStore)
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => database.close()
      resolve(database)
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('The storage database is blocked'))
  })
}

function request<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

// Resolves when the transaction has completed; rejects if it fails or is
// aborted.
function completion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('Aborted'))
  })
}

function abort(transaction: IDBTransaction) {
  try {
    transaction.abort()
  } catch {
    // Already finished or aborted.
  }
}

function read(database: IDBDatabase, playerId: string): Promise<User | undefined> {
  return request(
    database.transaction(userStore, 'readonly').objectStore(userStore).get(playerId),
  ) as Promise<User | undefined>
}

// The pointer, then the user it names, in one transaction.
function readMe(database: IDBDatabase): Promise<LoadUserResult> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([meStore, userStore], 'readonly')
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error ?? new Error('Aborted'))
    const pointer = transaction.objectStore(meStore).get(meEntry)
    pointer.onsuccess = () => {
      if (pointer.result === undefined) return resolve({ ok: true, user: null })
      const user = transaction.objectStore(userStore).get(pointer.result as string)
      user.onsuccess = () =>
        resolve({ ok: true, user: (user.result as User | undefined) ?? null })
    }
  })
}

// One transaction for the hello, its journal row and its user, resolved once
// all are on disk (strict durability where the browser offers it). If any put
// fails, the transaction is aborted, and none is kept.
//
// A record whose id is already kept is not written again, and gets no second
// journal row. An id is the hash of the body alone, and signatures are
// randomized, so one body signed twice is two valid records with one id: the
// same record (design section 7), and the first one kept stays. The user is
// put either way; it is minted from the body, so it is the same row.
//
// With me, the me entry is pointed at the user in the same transaction: if
// any put fails, none is kept.
function write(
  database: IDBDatabase,
  { id, record, user }: Minted,
  me: boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stores = [recordStore, journalStore, userStore]
    if (me) stores.push(meStore)
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
        if (kept.result !== undefined) return
        try {
          records.put(record, id)
          transaction
            .objectStore(journalStore)
            .add({ id, kind: 'hello', match: null, state: 'held' })
        } catch {
          abort(transaction)
        }
      }
      transaction.objectStore(userStore).put(user, user.playerId)
      if (me) transaction.objectStore(meStore).put(user.playerId, meEntry)
    } catch (error) {
      abort(transaction)
      reject(error)
    }
  })
}
