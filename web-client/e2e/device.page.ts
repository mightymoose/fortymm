import type { Page } from '@playwright/test'

// What a page load does for the device (src/device/land.ts), seen from the browser: the User
// Timing marks the app sets, and the key as kept in IndexedDB.

// The marks' names and the key's place, as in src/device/land.ts and src/device/device-key.ts.
const deviceKeyMark = 'fortymm:device-key'
const persistStorageMark = 'fortymm:persist-storage'
const keyDatabase = 'fortymm-device-key'
const keyStore = 'keys'
const keyEntry = 'signing'

export type DeviceKeyMark =
  | { ok: true; outcome: 'made' | 'kept' }
  | { ok: false; reason: string }

export type SigningKey = {
  // Whether script can export the private half: it must not.
  privateKeyExtractable: boolean
  // The public half, exported raw (uncompressed, 65 bytes), in hex.
  publicKey: string
}

export class DevicePage {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  async goto() {
    await this.page.goto('/')
  }

  async reload() {
    await this.page.reload()
  }

  // Before goto: counts every call the app makes to navigator.storage.persist().
  async countPersistRequests() {
    await this.page.addInitScript(() => {
      const storage = navigator.storage
      const persist = storage.persist.bind(storage)
      const counted = window as unknown as { persistRequests: number }
      counted.persistRequests = 0
      storage.persist = () => {
        counted.persistRequests += 1
        return persist()
      }
    })
  }

  // The device key's outcome on this page load, once it has settled.
  async findDeviceKeyMark(): Promise<DeviceKeyMark> {
    return (await this.findMark(deviceKeyMark)) as DeviceKeyMark
  }

  // The kept key, once this page load's key step has settled.
  async findSigningKey(): Promise<SigningKey> {
    await this.findMark(deviceKeyMark)
    return this.page.evaluate(
      async ({ keyDatabase, keyStore, keyEntry }) => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(keyDatabase)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        const pair = await new Promise<{ privateKey: CryptoKey; publicKey: CryptoKey }>(
          (resolve, reject) => {
            const request = database
              .transaction(keyStore, 'readonly')
              .objectStore(keyStore)
              .get(keyEntry)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          },
        )
        database.close()
        const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
        return {
          privateKeyExtractable: pair.privateKey.extractable,
          publicKey: Array.from(raw, (byte) => byte.toString(16).padStart(2, '0')).join(''),
        }
      },
      { keyDatabase, keyStore, keyEntry },
    )
  }

  // How many times this page load asked for persistent storage (see countPersistRequests), once
  // the persist step has settled.
  async findPersistRequests(): Promise<number> {
    await this.findMark(persistStorageMark)
    return this.page.evaluate(() => (window as unknown as { persistRequests: number }).persistRequests)
  }

  // The detail of this page load's mark of that name, once it is set. Every detail the app sets
  // is truthy (an object or a non-empty string), so waiting for it waits for the mark.
  private async findMark(name: string): Promise<unknown> {
    const handle = await this.page.waitForFunction(
      (name) => (performance.getEntriesByName(name, 'mark')[0] as PerformanceMark | undefined)?.detail,
      name,
    )
    try {
      return await handle.jsonValue()
    } finally {
      await handle.dispose()
    }
  }
}
