import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { cleanup } from '@testing-library/react'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { dropRequestsInFlight } from './scoring/demoServer'
import { server } from './test/server'

// jsdom doesn't implement scrollTo, which the router calls on navigation.
window.scrollTo = () => {}

// jsdom has <dialog>'s `open` but none of its methods. These open and close a
// dialog as a browser does, without the top layer, Esc or the focus moves,
// which the Playwright suite checks.
const returnValues = new WeakMap<HTMLDialogElement, string>()
Object.defineProperty(HTMLDialogElement.prototype, 'returnValue', {
  get(this: HTMLDialogElement) {
    return returnValues.get(this) ?? ''
  },
  set(this: HTMLDialogElement, value: string) {
    returnValues.set(this, value)
  },
})
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.open = true
}
HTMLDialogElement.prototype.close = function (this: HTMLDialogElement, value?: string) {
  if (!this.open) return
  this.open = false
  if (value !== undefined) this.returnValue = value
  this.dispatchEvent(new Event('close'))
}

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' })
})

afterEach(() => {
  cleanup()
  server.resetHandlers()
  // The saved session, and the sidebar's choice, must not leak between tests.
  localStorage.clear()
  // Nor may a scratchpad change still on its way to the demo server.
  dropRequestsInFlight()
  // Nor may the signing key. A new IndexedDB, rather than a deleted
  // database, also keeps a registration still in flight out of the next test.
  globalThis.indexedDB = new IDBFactory()
})

afterAll(() => {
  server.close()
})
