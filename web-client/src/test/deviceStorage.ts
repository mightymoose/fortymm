import type { Bytes } from '../signing/bytes'

// The browser's site data, as a test sees it from outside the app.

// Deletes the app's IndexedDB database, as Safari does after 7 days without
// a visit.
export function clearSiteData(): Promise<void> {
  return request(indexedDB.deleteDatabase('fortymm')).then(() => undefined)
}

// Puts a signed result in the queue that the offline exchange (#195) fills.
export async function queueSignedResult(id: string, envelope: Bytes): Promise<void> {
  await withQueue('readwrite', (queue) => queue.put(envelope, id))
}

export async function queuedResults(): Promise<unknown[]> {
  return (await withQueue('readonly', (queue) => queue.getAll())) as unknown[]
}

async function withQueue(
  mode: IDBTransactionMode,
  run: (queue: IDBObjectStore) => IDBRequest,
): Promise<unknown> {
  // The app makes the database, so it must have loaded first.
  const database = (await request(indexedDB.open('fortymm'))) as IDBDatabase
  try {
    return await request(run(database.transaction('signed-results', mode).objectStore('signed-results')))
  } finally {
    database.close()
  }
}

function request(pending: IDBRequest | IDBOpenDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    pending.onsuccess = () => resolve(pending.result)
    pending.onerror = () => reject(pending.error)
  })
}
