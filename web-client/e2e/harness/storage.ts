import { loadCore } from '../../src/core/load.ts'
import { deviceKey, storedSignature } from '../../src/device-key.ts'
import {
  loadUser,
  recordStore,
  storageDatabase,
  storeRecord,
  userStore,
} from '../../src/storage.ts'

// The browser suite's handle on src/storage.ts, which no screen writes to
// yet: a test-only page (storage.html) built from the app's own modules into
// the "harness" deployment (scripts/e2e-deployments.ts) and kept on the
// device with the rest of that build. Tests call these through
// page.evaluate(() => window.storageHarness...). Every function goes through
// the module's public interface, except kept, which counts what is in
// IndexedDB.

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

const development = 3

// A hello signed by this device's key, made as the first launch will make
// it: the core builds the body, the device key signs it, the core assembles
// and verifies it.
async function makeHello(): Promise<Uint8Array> {
  const result = await deviceKey()
  if (!result.ok) throw new Error(`No device key: ${result.reason}`)
  const core = await loadCore()
  const random = crypto.getRandomValues(new Uint8Array(8))
  const body = core.helloBody(development, result.key.publicKey, random)
  return core.assemble(body, storedSignature(core, await result.key.sign(body)))
}

// What the core gives for this device's key, independently of any record.
async function expectedUser() {
  const result = await deviceKey()
  if (!result.ok) throw new Error(`No device key: ${result.reason}`)
  const core = await loadCore()
  const { publicKey } = result.key
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
