import { loadCore } from '../../src/core/load.ts'
import {
  keptPublicKey,
  keyDatabase,
  keyEntry,
  keyStore,
  storedSignature,
  withDeviceKey,
  type DeviceKey,
} from '../../src/device-key.ts'
import { environment } from '../../src/first-launch.ts'
import { appendLock } from '../../src/storage.ts'

// The browser suite's handle on src/device-key.ts: a test-only page
// (device-key.html) built from the app's own modules into the "harness"
// deployment (scripts/e2e-deployments.ts) and kept on the device with the
// rest of that build. Tests call these through
// page.evaluate(() => window.deviceKeyHarness...). Every function goes
// through the module's public interface, except keysKept and keptPrivateKey,
// which look at what is in IndexedDB, and appendLocks, holdAppendLock and
// releaseAppendLock, which look at and take the lock directly.

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

// The key, handed out of withDeviceKey's callback: fine for these tests,
// which sign with it after the lock is released.
async function key(): Promise<DeviceKey> {
  const result = await withDeviceKey(async (key) => key)
  if (!result.ok) throw new Error(`No device key: ${result.reason}`)
  return result.value
}

// What a promise gave, or 'timed out' if it hasn't settled within 3 seconds:
// a call waiting on a lock that is never released.
function within<T>(promise: Promise<T>): Promise<T | 'timed out'> {
  return Promise.race([
    promise,
    new Promise<'timed out'>((resolve) => setTimeout(() => resolve('timed out'), 3_000)),
  ])
}

// How many hold the append lock, and how many wait for it, in the origin.
async function appendLocks() {
  const { held = [], pending = [] } = await navigator.locks.query()
  return {
    held: held.filter(({ name }) => name === appendLock).length,
    pending: pending.filter(({ name }) => name === appendLock).length,
  }
}

let releaseHeld: (() => void) | undefined

const harness = {
  // The device key's public key in hex, or why there is none.
  async publicKey(): Promise<string> {
    const result = await withDeviceKey(async (key) => hex(key.publicKey))
    return result.ok ? result.value : `failed: ${result.reason}`
  },

  appendLocks,

  // Inside withDeviceKey's callback: makes a hello, stores it and loads its
  // user with the store the callback gets, and looks at the append lock.
  // Each store call gives 'timed out' if it waits on the lock. After the
  // callback: the append lock once withDeviceKey has returned.
  async storeInsideCallback() {
    const core = await loadCore()
    const result = await withDeviceKey(async (key, store) => {
      const body = core.helloBody(environment, key.publicKey, random())
      const hello = core.assemble(body, storedSignature(core, await key.sign(body)))
      const stored = await within(store.storeRecord(hello))
      const loaded = await within(store.loadUser(hex(core.ownPlayerId(key.publicKey))))
      return {
        stored,
        username: typeof loaded === 'string' || !loaded.ok ? loaded : loaded.user?.username,
        expectedUsername: core.username(core.ownPlayerId(key.publicKey), 4),
        locksInside: await appendLocks(),
      }
    })
    return { result, locksAfter: await appendLocks() }
  },

  // A callback that throws: the error withDeviceKey gives, then whether a
  // later call runs its callback, and the append lock after both.
  async throwingCallbackThenAnother() {
    const thrown = await withDeviceKey(async () => {
      throw new Error('The callback failed')
    }).then(
      () => 'nothing thrown',
      (error: unknown) => (error instanceof Error ? error.message : 'not an Error'),
    )
    const later = await within(withDeviceKey(async () => 'ran'))
    return { thrown, later, locksAfter: await appendLocks() }
  },

  // Takes the append lock and keeps it until releaseAppendLock: what another
  // tab's journal append would do, for as long as a test needs.
  holdAppendLock(): Promise<void> {
    return new Promise((held) => {
      void navigator.locks.request(
        appendLock,
        () =>
          new Promise<void>((release) => {
            releaseHeld = release
            held()
          }),
      )
    })
  },

  async releaseAppendLock() {
    releaseHeld?.()
  },

  // The kept key's public key in hex, read only: 'none' when no key is kept.
  async keptPublicKey(): Promise<string> {
    const result = await keptPublicKey()
    if (!result.ok) return `failed: ${result.reason}`
    return result.publicKey === null ? 'none' : hex(result.publicKey)
  },

  // What the core makes of the public key.
  async coreIds() {
    const { publicKey } = await key()
    const core = await loadCore()
    return {
      accountId: hex(core.accountId(publicKey)),
      ownPlayerId: hex(core.ownPlayerId(publicKey)),
    }
  },

  // Signs a hello's body (bytes the core checks a signature over, with the
  // public key in them) and asks the core whether the signature verifies:
  // for those bytes, and for another body, with the same key, that differs
  // only in its random value.
  async signAndVerify() {
    const device = await key()
    const core = await loadCore()
    const body = core.helloBody(environment, device.publicKey, random())
    const other = core.helloBody(environment, device.publicKey, random())
    const raw = await device.sign(body)
    const signature = storedSignature(core, raw)
    return {
      rawLength: raw.length,
      verifies: verifies(() => core.assemble(body, signature)),
      verifiesOtherBytes: verifies(() => core.assemble(other, signature)),
    }
  },

  // How many keys IndexedDB holds, without creating the database.
  async keysKept(): Promise<number> {
    const databases = await indexedDB.databases()
    if (!databases.some(({ name }) => name === keyDatabase)) return 0
    const database = await open()
    try {
      return await request(
        database.transaction(keyStore).objectStore(keyStore).count(),
      )
    } finally {
      database.close()
    }
  },

  // The kept private key, as script on the origin sees it, and what asking
  // to export it in each format gives.
  async keptPrivateKey() {
    const database = await open()
    let pair: { privateKey: CryptoKey }
    try {
      pair = await request(
        database.transaction(keyStore).objectStore(keyStore).get(keyEntry),
      )
    } finally {
      database.close()
    }
    const exports: Record<string, string> = {}
    for (const format of ['pkcs8', 'jwk'] as const) {
      exports[format] = await crypto.subtle
        .exportKey(format, pair.privateKey)
        .then(
          () => 'exported',
          (error: unknown) => (error instanceof DOMException ? error.name : 'error'),
        )
    }
    return {
      isCryptoKey: pair.privateKey instanceof CryptoKey,
      type: pair.privateKey.type,
      extractable: pair.privateKey.extractable,
      exports,
    }
  },
}

function random() {
  return crypto.getRandomValues(new Uint8Array(8))
}

function verifies(assemble: () => unknown): boolean {
  try {
    assemble()
    return true
  } catch {
    return false
  }
}

function open(): Promise<IDBDatabase> {
  return request(indexedDB.open(keyDatabase))
}

function request<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

declare global {
  interface Window {
    deviceKeyHarness: typeof harness
  }
}
window.deviceKeyHarness = harness
