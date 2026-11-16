import { type Change, onChange } from '../../src/changes.ts'
import { loadCore } from '../../src/core/load.ts'
import { storedSignature, withDeviceKey } from '../../src/device-key.ts'
import { environment } from '../../src/first-launch.ts'
import {
  appendLock,
  loadMatch,
  loadMatches,
  loadMe,
  loadUser,
  rebuildViews,
  recordStore,
  storageDatabase,
  storeRecord,
  userStore,
} from '../../src/storage.ts'

// The browser suite's handle on src/storage.ts: a test-only page
// (storage.html) built from the app's own modules into the "harness"
// deployment (scripts/e2e-deployments.ts) and kept on the device with the
// rest of that build. Tests call these through
// page.evaluate(() => window.storageHarness...). Every function goes through
// the module's public interface, except kept and keptRecord, which look at
// what is in IndexedDB.

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

// A hello signed by this device's key, made as the first launch makes it:
// the core builds the body, the device key signs it, the core assembles and
// verifies it.
async function makeHello(): Promise<Uint8Array> {
  const [hello] = await signedHellos(1)
  return hello
}

// One hello body, signed the given number of times. ECDSA signatures are
// randomized, so each is a different valid record with the same id (a
// record's id is the hash of its body).
async function signedHellos(times: number): Promise<Uint8Array[]> {
  const core = await loadCore()
  const result = await withDeviceKey(async (key) => {
    const random = crypto.getRandomValues(new Uint8Array(8))
    const body = core.helloBody(environment, key.publicKey, random)
    const hellos = []
    for (let i = 0; i < times; i++) {
      hellos.push(core.assemble(body, storedSignature(core, await key.sign(body))))
    }
    return hellos
  })
  if (!result.ok) throw new Error(`No device key: ${result.reason}`)
  return result.value
}

// The record kept under a record's id, as IndexedDB gives it back: its bytes
// and the size of the buffer behind them.
async function keptRecord(record: Uint8Array) {
  const core = await loadCore()
  const database = await request(indexedDB.open(storageDatabase))
  let kept: Uint8Array
  try {
    kept = await request(
      database
        .transaction(recordStore)
        .objectStore(recordStore)
        .get(hex(core.id(record))),
    )
  } finally {
    database.close()
  }
  return {
    hex: hex(kept),
    byteLength: kept.byteLength,
    bufferByteLength: kept.buffer.byteLength,
  }
}

// Runs `during` while storeRecord waits for the append lock, which this page
// holds until then.
async function whileStoreWaitsForTheLock(
  record: Uint8Array,
  during: () => void,
) {
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  await new Promise<void>((granted) => {
    void navigator.locks.request(appendLock, () => {
      granted()
      return held
    })
  })
  const storing = storeRecord(record)
  while (
    !(await navigator.locks.query()).pending?.some(({ name }) => name === appendLock)
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  during()
  release()
  return storing
}

// What the core gives for this device's key, independently of any record.
async function expectedUser() {
  const result = await withDeviceKey(async (key) => key.publicKey)
  if (!result.ok) throw new Error(`No device key: ${result.reason}`)
  const core = await loadCore()
  const publicKey = result.value
  const playerId = core.ownPlayerId(publicKey)
  return {
    playerId: hex(playerId),
    accountId: hex(core.accountId(publicKey)),
    username: core.username(playerId, 4),
    publicKey: hex(publicKey),
  }
}

const bytes = (hexString: string) =>
  Uint8Array.from(hexString.match(/../g) ?? [], (pair) => parseInt(pair, 16))

// A record to make, signed by this device's key.
// - player: a fresh player (its id is the record's extra player id).
// - match: this device's own player against `opponent`, with terms
//   termsBytes(bestOf, rated), or the bytes `terms` (hex) when given.
// - score: game `slot` of `match`, the score or null (cleared), naming
//   `replaces` (hex ids) as replaced.
// - again: the body of `record` (hex) signed once more: another valid record
//   with the same id.
type Spec =
  | { kind: 'player' }
  | { kind: 'match'; opponent: string; bestOf: number; rated: boolean; terms?: string }
  | {
      kind: 'score'
      match: string
      slot: number
      score: [number, number] | null
      replaces: string[]
    }
  | { kind: 'again'; record: string }

// A made record: its bytes and id (hex), and for a player, its player id.
type Made = { record: string; id: string; player?: string }

// Makes each record of specs, in order, inside one withDeviceKey callback:
// the core builds the body, the device key signs it, the core assembles and
// verifies it, as the first launch makes a hello. Stores nothing.
async function makeRecords(specs: Spec[]): Promise<Made[]> {
  const core = await loadCore()
  const result = await withDeviceKey(async (key) => {
    const me = core.ownPlayerId(key.publicKey)
    const made: Made[] = []
    for (const spec of specs) {
      const random = crypto.getRandomValues(new Uint8Array(8))
      let body: Uint8Array
      if (spec.kind === 'player') {
        body = core.playerBody(environment, key.publicKey, random)
      } else if (spec.kind === 'match') {
        const terms =
          spec.terms === undefined ? core.termsBytes(spec.bestOf, spec.rated) : bytes(spec.terms)
        body = core.matchBody(environment, key.publicKey, random, [[me], [bytes(spec.opponent)]], terms)
      } else if (spec.kind === 'score') {
        body = core.scoreBody(
          environment,
          key.publicKey,
          random,
          bytes(spec.match),
          spec.slot,
          core.scoreValue(spec.score),
          spec.replaces.map(bytes),
        )
      } else {
        body = core.body(bytes(spec.record))
      }
      const record = core.assemble(body, storedSignature(core, await key.sign(body)))
      const player = core.extraPlayerId(record)
      made.push({
        record: hex(record),
        id: hex(core.id(record)),
        ...(spec.kind === 'player' && player !== null ? { player: hex(player) } : {}),
      })
    }
    return made
  })
  if (!result.ok) throw new Error(`No device key: ${result.reason}`)
  return result.value
}

// A view row or anything else IndexedDB gives back, with every byte array as
// hex, so it can cross to the test.
function plain(value: unknown): unknown {
  if (value instanceof Uint8Array) return hex(value)
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]))
  }
  return value
}

// Opens the storage database as it is, or gives null when there is none,
// without creating it.
async function openExisting(): Promise<IDBDatabase | null> {
  const databases = await indexedDB.databases()
  if (!databases.some(({ name }) => name === storageDatabase)) return null
  return request(indexedDB.open(storageDatabase))
}

// What the core's matchState gives for each match the kept records are
// about, worked out here from the `records` store alone, with the core's
// getters: not through the journal, its index or the view. Keyed by match id
// (hex); null for a match none of whose kept records is its `match` record.
async function expectedViews(): Promise<Record<string, unknown>> {
  const core = await loadCore()
  const database = await openExisting()
  if (database === null) return {}
  let kept: Uint8Array[]
  try {
    kept = (await request(
      database.transaction(recordStore).objectStore(recordStore).getAll(),
    )) as Uint8Array[]
  } finally {
    database.close()
  }
  const about = new Map<string, Uint8Array[]>()
  for (const record of kept) {
    const kind = core.kind(record)
    const match =
      kind === 'match' ? core.id(record) : kind === 'score' ? core.scoredMatch(record) : null
    if (match === null) continue
    const id = hex(match)
    about.set(id, [...(about.get(id) ?? []), record])
  }
  return Object.fromEntries(
    [...about].map(([id, records]) => [id, plain(core.matchState(records))]),
  )
}

// Every change this page has heard since listen() (src/changes.ts).
const heard: Change[] = []

// Makes IndexedDB writes (put and add) to a store fail, for one key or for
// every key, until stopFailing(), in one of two ways:
// - refused: the call throws at once, as a value the browser can't clone.
// - aborted: the write goes through, and once it has succeeded the browser
//   aborts its transaction, as a transaction that fails at commit (a full
//   disk, a quota) does: asynchronously, after every request before it
//   succeeded.
// Writes made with a key (put(value, key)) are matched by that key; add with
// an autoIncrement key has none, so a key-filtered failure never matches it.
export type FailWrites = 'refused' | 'aborted'
let failing: { store: string; key: string | null; how: FailWrites } | null = null
const put = IDBObjectStore.prototype.put
const add = IDBObjectStore.prototype.add
IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args) {
  return failIfFailing(this, args[1], () => put.apply(this, args))
}
IDBObjectStore.prototype.add = function (this: IDBObjectStore, ...args) {
  return failIfFailing(this, args[1], () => add.apply(this, args))
}
function failIfFailing(
  store: IDBObjectStore,
  key: unknown,
  write: () => IDBRequest<IDBValidKey>,
): IDBRequest<IDBValidKey> {
  const matches =
    failing !== null &&
    store.name === failing.store &&
    (failing.key === null || key === failing.key)
  if (!matches) return write()
  if (failing!.how === 'refused') throw new DOMException('Refused', 'DataCloneError')
  const written = write()
  const transaction = store.transaction
  written.addEventListener('success', () => transaction.abort())
  return written
}

const harness = {
  makeRecords,

  // This device's own player id (hex), made from its key.
  async ownPlayerId() {
    const core = await loadCore()
    const result = await withDeviceKey(async (key) => hex(core.ownPlayerId(key.publicKey)))
    if (!result.ok) throw new Error(`No device key: ${result.reason}`)
    return result.value
  },

  // Appends records (hex) through withDeviceKey's store, as a commit will:
  // what store.append answered.
  async append(records: string[]) {
    const result = await withDeviceKey((_key, store) => store.append(records.map(bytes)))
    if (!result.ok) throw new Error(`No device key: ${result.reason}`)
    return result.value
  },

  // Each batch of records (hex) appended in turn, one append each: what
  // each answered.
  async appendEach(batches: string[][]) {
    const results = []
    for (const batch of batches) results.push(await harness.append(batch))
    return results
  },

  // What withDeviceKey's store.loadMatch gives: the match with its current
  // entries.
  async heldLoadMatch(matchId: string) {
    const result = await withDeviceKey((_key, store) => store.loadMatch(matchId))
    if (!result.ok) throw new Error(`No device key: ${result.reason}`)
    return result.value
  },

  loadMatch(matchId: string) {
    return loadMatch(matchId)
  },

  loadMatches() {
    return loadMatches()
  },

  rebuildViews() {
    return rebuildViews()
  },

  expectedViews,

  // Every entry of a store, in key order, as [key, value] with bytes as hex;
  // [] when there is no database yet.
  async readStore(name: string): Promise<[unknown, unknown][]> {
    const database = await openExisting()
    if (database === null) return []
    try {
      const store = database.transaction(name).objectStore(name)
      const [keys, values] = await Promise.all([
        request(store.getAllKeys()),
        request(store.getAll()),
      ])
      return keys.map((key, i) => [plain(key), plain(values[i])])
    } finally {
      database.close()
    }
  },

  // Empties a store, bypassing storage.ts. With no database yet, there is
  // nothing to empty (and opening one here would make it without its stores).
  async clearStore(name: string) {
    const database = await openExisting()
    if (database === null) return
    try {
      await request(database.transaction(name, 'readwrite').objectStore(name).clear())
    } finally {
      database.close()
    }
  },

  // Puts value under key in a store, bypassing storage.ts: a row as a bug,
  // an older build or another shape of the view would leave.
  async putEntry(name: string, key: string, value: unknown) {
    const database = await openExisting()
    if (database === null) throw new Error('No storage database yet')
    try {
      await request(database.transaction(name, 'readwrite').objectStore(name).put(value, key))
    } finally {
      database.close()
    }
  },

  // Deletes the entry under key in a store, bypassing storage.ts.
  async deleteEntry(name: string, key: string) {
    const database = await openExisting()
    if (database === null) throw new Error('No storage database yet')
    try {
      await request(database.transaction(name, 'readwrite').objectStore(name).delete(key))
    } finally {
      database.close()
    }
  },

  failWrites(store: string, key: string | null = null, how: FailWrites = 'refused') {
    failing = { store, key, how }
  },

  stopFailing() {
    failing = null
  },

  // Starts keeping every change this page hears.
  listen() {
    onChange((change) => heard.push(change))
  },

  heard() {
    return heard
  },

  // What loadMe gives: this device's user.
  loadMe() {
    return loadMe()
  },

  // Makes a hello and stores it as this device's own, as the first launch
  // does: storeRecord(hello, { me: true }) with withDeviceKey's store. What
  // it answered, and what the core gives for the key.
  async storeOwnHello() {
    const core = await loadCore()
    const result = await withDeviceKey(async (key, store) => {
      const random = crypto.getRandomValues(new Uint8Array(8))
      const body = core.helloBody(environment, key.publicKey, random)
      const hello = core.assemble(body, storedSignature(core, await key.sign(body)))
      return store.storeRecord(hello, { me: true })
    })
    if (!result.ok) throw new Error(`No device key: ${result.reason}`)
    return { result: result.value, expected: await expectedUser() }
  },

  // A hello signed by this device's key (hex), made and not stored.
  async hello() {
    return hex(await makeHello())
  },

  // What the public storeRecord answers for a record (hex).
  storeRecord(record: string) {
    return storeRecord(bytes(record))
  },

  // Makes a hello and stores it the given number of times: what each
  // storeRecord answered, and what the core gives for the key that signed it.
  async storeHello(times = 1) {
    const hello = await makeHello()
    const results = []
    for (let i = 0; i < times; i++) results.push(await storeRecord(hello))
    return { results, expected: await expectedUser() }
  },

  // Stores a hello, and flips a byte of its signature in the caller's array
  // while storeRecord waits for the append lock: what storeRecord answered,
  // the hello's bytes as signed, and what was kept under its id.
  async storeWhileCallerChangesIt() {
    const hello = await makeHello()
    const signed = hello.slice()
    const result = await whileStoreWaitsForTheLock(hello, () => {
      hello[hello.length - 1] ^= 0xff
    })
    return { result, signed: hex(signed), kept: await keptRecord(signed) }
  },

  // Stores a hello given as a view into a much larger buffer: what
  // storeRecord answered, the hello's bytes, and what was kept.
  async storeAsSlice() {
    const hello = await makeHello()
    const buffer = new Uint8Array(100_000 + hello.length)
    buffer.set(hello, 500)
    const slice = buffer.subarray(500, 500 + hello.length)
    const result = await storeRecord(slice)
    return { result, signed: hex(hello), length: hello.length, kept: await keptRecord(hello) }
  },

  // Signs one hello body twice (two valid records with one id) and stores
  // the first, then the second: what each storeRecord answered, both
  // records' bytes, what was kept under their id, and the counts.
  async storeTwoSignaturesOfOneBody() {
    const [first, second] = await signedHellos(2)
    const results = [await storeRecord(first), await storeRecord(second)]
    return {
      results,
      first: hex(first),
      second: hex(second),
      kept: await keptRecord(first),
      counts: await harness.kept(),
    }
  },

  // What the core gives for this device's key (made if none is kept):
  // the user a hello signed by it mints.
  expectedUser,

  // What loadUser gives for a player id (hex).
  loadUser(playerId: string) {
    return loadUser(playerId)
  },

  // How many records and users IndexedDB holds, without creating the
  // database.
  async kept(): Promise<{ records: number; users: number }> {
    const databases = await indexedDB.databases()
    if (!databases.some(({ name }) => name === storageDatabase)) {
      return { records: 0, users: 0 }
    }
    const database = await request(indexedDB.open(storageDatabase))
    try {
      const transaction = database.transaction([recordStore, userStore])
      return {
        records: await request(transaction.objectStore(recordStore).count()),
        users: await request(transaction.objectStore(userStore).count()),
      }
    } finally {
      database.close()
    }
  },
}

function request<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

declare global {
  interface Window {
    storageHarness: typeof harness
  }
}
window.storageHarness = harness
