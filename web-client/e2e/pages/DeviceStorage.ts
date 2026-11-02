// The callbacks of page.evaluate() run in the browser.
/// <reference lib="dom" />
import type { Page } from '@playwright/test'
import type { components } from '../../src/api/schema.d.ts'

type SigningKey = components['schemas']['AccountSigningKey']

// The app's IndexedDB database, read from the page: the device's signing
// key and the queue of signed results.
export class DeviceStorage {
  readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  // The key that the API answers the next registration with. Start waiting
  // before the page load that registers.
  async nextRegistration(): Promise<SigningKey> {
    const response = await this.page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/account/signing-keys') &&
        response.request().method() === 'POST',
    )
    if (!response.ok()) throw new Error(`The registration answered ${response.status()}`)
    return ((await response.json()) as { data: SigningKey }).data
  }

  // The stored key's id as lowercase hex, or null with no key.
  deviceKeyId(): Promise<string | null> {
    return this.page.evaluate(async () => {
      const key = await new Promise<{ kid: Uint8Array } | undefined>((resolve, reject) => {
        const opened = indexedDB.open('fortymm')
        opened.onerror = () => reject(opened.error)
        opened.onsuccess = () => {
          const read = opened.result.transaction('device-key').objectStore('device-key').get('current')
          read.onsuccess = () => resolve(read.result)
          read.onerror = () => reject(read.error)
        }
      })
      return key ? Array.from(key.kid, (byte) => byte.toString(16).padStart(2, '0')).join('') : null
    })
  }

  // Puts a result in the queue, as the offline exchange (#195) will.
  queueSignedResult(id: string, value: string): Promise<void> {
    return this.page.evaluate(
      ([id, value]) =>
        new Promise<void>((resolve, reject) => {
          const opened = indexedDB.open('fortymm')
          opened.onerror = () => reject(opened.error)
          opened.onsuccess = () => {
            const transaction = opened.result.transaction('signed-results', 'readwrite')
            transaction.objectStore('signed-results').put(value, id)
            transaction.oncomplete = () => resolve()
            transaction.onerror = () => reject(transaction.error)
          }
        }),
      [id, value],
    )
  }

  queuedResults(): Promise<unknown[]> {
    return this.page.evaluate(
      () =>
        new Promise<unknown[]>((resolve, reject) => {
          const opened = indexedDB.open('fortymm')
          opened.onerror = () => reject(opened.error)
          opened.onsuccess = () => {
            const read = opened.result
              .transaction('signed-results')
              .objectStore('signed-results')
              .getAll()
            read.onsuccess = () => resolve(read.result)
            read.onerror = () => reject(read.error)
          }
        }),
    )
  }
}
