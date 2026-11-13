import { loadCore } from '../../src/core/load.ts'
import {
  deviceKey,
  keptPublicKey,
  keyDatabase,
  keyEntry,
  keyStore,
  storedSignature,
} from '../../src/device-key.ts'

// The browser suite's handle on src/device-key.ts, which no screen uses yet:
// a test-only page (device-key.html) built from the app's own modules into
// the "harness" deployment (scripts/e2e-deployments.ts) and kept on the
// device with the rest of that build. Tests call these through
// page.evaluate(() => window.deviceKeyHarness...). Every function goes
// through the module's public interface, except keysKept and keptPrivateKey,
// which look at what is in IndexedDB.

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

const development = 3

async function key() {
  const result = await deviceKey()
  if (!result.ok) throw new Error(`No device key: ${result.reason}`)
  return result.key
}

const harness = {
  // The device key's public key in hex, or why there is none.
  async publicKey(): Promise<string> {
    const result = await deviceKey()
    return result.ok ? hex(result.key.publicKey) : `failed: ${result.reason}`
  },

  // The kept key's public key in hex, read only: 'none' when no key is kept.
  async keptPublicKey(): Promise<string> {
    const result = await keptPublicKey()
    if (!result.ok) return `failed: `
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
    const body = core.helloBody(development, device.publicKey, random())
    const other = core.helloBody(development, device.publicKey, random())
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
