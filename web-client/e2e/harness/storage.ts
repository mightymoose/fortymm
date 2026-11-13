import { loadCore } from '../../src/core/load.ts'
import { storedSignature, withDeviceKey } from '../../src/device-key.ts'
import { environment } from '../../src/first-launch.ts'
import {
  appendLock,
  loadUser,
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

const harness = {
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
