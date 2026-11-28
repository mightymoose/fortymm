import { afterEach, describe, expect, vi } from 'vitest'
import { it } from '../setupTests.ts'
import { deviceKey } from './device-key.ts'

// The typed failures when the browser lacks, or refuses, what the key needs. jsdom has no
// IndexedDB or Web Locks, so making, keeping and reusing a real non-extractable key are proven in
// the browser (e2e/device-key.spec.ts).

// A Web Locks stand-in that grants every request at once.
const grantingLocks = {
  request: (_name: string, granted: () => Promise<unknown>) => granted(),
}
// One that refuses every request, as a browser does with site data blocked.
const refusingLocks = {
  request: () => Promise.reject(new DOMException('Refused', 'SecurityError')),
}
// An IndexedDB stand-in whose open fails.
const refusingIndexedDB = {
  open() {
    const request: Partial<IDBOpenDBRequest> = {}
    setTimeout(() => {
      Object.assign(request, { error: new DOMException('Refused', 'UnknownError') })
      request.onerror?.call(request as IDBOpenDBRequest, new Event('error'))
    })
    return request
  },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('deviceKey', () => {
  it('is signing-unavailable without WebCrypto', async () => {
    vi.stubGlobal('crypto', {})
    expect(await deviceKey()).toEqual({ ok: false, reason: 'signing-unavailable' })
  })

  it('is storage-unavailable without IndexedDB', async () => {
    vi.stubGlobal('indexedDB', undefined)
    expect(await deviceKey()).toEqual({ ok: false, reason: 'storage-unavailable' })
  })

  it('is locks-unavailable without Web Locks', async () => {
    vi.stubGlobal('indexedDB', refusingIndexedDB)
    vi.stubGlobal('navigator', { locks: undefined })
    expect(await deviceKey()).toEqual({ ok: false, reason: 'locks-unavailable' })
  })

  it('is storage-unavailable when the lock is refused', async () => {
    vi.stubGlobal('indexedDB', refusingIndexedDB)
    vi.stubGlobal('navigator', { locks: refusingLocks })
    expect(await deviceKey()).toEqual({ ok: false, reason: 'storage-unavailable' })
  })

  it('is storage-unavailable when IndexedDB refuses to open', async () => {
    vi.stubGlobal('indexedDB', refusingIndexedDB)
    vi.stubGlobal('navigator', { locks: grantingLocks })
    expect(await deviceKey()).toEqual({ ok: false, reason: 'storage-unavailable' })
  })
})
