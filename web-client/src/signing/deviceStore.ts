import type { Bytes } from './bytes'

// The device's IndexedDB database. It holds the device's signing key, which
// a sign-out deletes, and the queue of signed results, which a sign-out
// keeps: a signed result no longer needs the key, and may be the only copy
// of a finished match.
const DATABASE = 'fortymm'
const VERSION = 1
export const DEVICE_KEY_STORE = 'device-key'
export const SIGNED_RESULTS_STORE = 'signed-results'
const DEVICE_KEY = 'current'

// The key's private half never leaves the browser: it is non-extractable,
// and IndexedDB stores the CryptoKey itself.
export type DeviceKey = {
  privateKey: CryptoKey
  coseKey: Bytes
  kid: Bytes
}

export async function loadDeviceKey(): Promise<DeviceKey | null> {
  const key = await withStore('readonly', (store) => store.get(DEVICE_KEY))
  return (key as DeviceKey | undefined) ?? null
}

export async function saveDeviceKey(key: DeviceKey): Promise<void> {
  await withStore('readwrite', (store) => store.put(key, DEVICE_KEY))
}

export async function deleteDeviceKey(): Promise<void> {
  await withStore('readwrite', (store) => store.delete(DEVICE_KEY))
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(DEVICE_KEY_STORE)
      // The queue's writer comes with the offline exchange (#195). The store
      // is here first, so a sign-out already shows that it keeps it.
      request.result.createObjectStore(SIGNED_RESULTS_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<unknown> {
  const database = await open()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(DEVICE_KEY_STORE, mode)
      const request = run(transaction.objectStore(DEVICE_KEY_STORE))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
}
