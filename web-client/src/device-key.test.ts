import { afterEach, expect, test, vi } from 'vitest'
import { loadCore } from './core/load.ts'
import { compressedPublicKey, withDeviceKey } from './device-key.ts'

// The parts of the device key that need no real browser: compressing the
// public key, and the typed failure when the browser lacks what the key
// needs. Keeping, reusing and signing with a real non-extractable key are
// proven in the browser suite (e2e/tests/device-key.spec.ts).

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16))

// Two points of P-256, uncompressed: the generator G (y odd) and 3G (y even).
// Their compressed forms were checked against Node's
// crypto.ECDH.convertKey(..., 'compressed').
const generator = {
  uncompressed:
    '04' +
    '6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296' +
    '4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5',
  compressed: '036b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296',
}
const threeTimesGenerator = {
  uncompressed:
    '04' +
    '5ecbe4d1a6330a44c8f7ef951d4bf165e6c6b721efada985fb41661bc6e7fd6c' +
    '8734640c4998ff7e374b06ce1a64a2ecd82ab036384fb83d9a79b127a27d5032',
  compressed: '025ecbe4d1a6330a44c8f7ef951d4bf165e6c6b721efada985fb41661bc6e7fd6c',
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('a public key with an odd y compresses to 03 and its x', () => {
  expect(hex(compressedPublicKey(bytes(generator.uncompressed)))).toBe(
    generator.compressed,
  )
})

test('a public key with an even y compresses to 02 and its x', () => {
  expect(hex(compressedPublicKey(bytes(threeTimesGenerator.uncompressed)))).toBe(
    threeTimesGenerator.compressed,
  )
})

test('the core accepts a compressed public key: it gives its account id and own player id', async () => {
  const core = await loadCore()
  for (const point of [generator, threeTimesGenerator]) {
    const publicKey = compressedPublicKey(bytes(point.uncompressed))
    expect(core.accountId(publicKey)).toHaveLength(32)
    expect(core.ownPlayerId(publicKey)).toHaveLength(32)
  }
})

test('anything but a 65-byte key starting 04 is refused', () => {
  expect(() => compressedPublicKey(bytes(generator.compressed))).toThrow()
  expect(() =>
    compressedPublicKey(bytes('05' + generator.uncompressed.slice(2))),
  ).toThrow()
})

// IndexedDB stand-ins: jsdom has none. Only what the module reaches before
// it would make a key.
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
// A Web Locks stand-in that grants every request at once.
const locks = {
  request: (_name: string, granted: () => Promise<unknown>) => granted(),
}

function keysMade() {
  return vi.spyOn(crypto.subtle, 'generateKey')
}

// withDeviceKey's callback: never called when there is no key.
const callback = vi.fn(async () => 'called')
afterEach(() => {
  expect(callback).not.toHaveBeenCalled()
})

test('with no WebCrypto (an insecure context), the result is signing-unavailable', async () => {
  vi.stubGlobal('crypto', {})

  expect(await withDeviceKey(callback)).toEqual({ ok: false, reason: 'signing-unavailable' })
})

test('with no IndexedDB, the result is storage-unavailable, and no key is made', async () => {
  const made = keysMade()
  vi.stubGlobal('indexedDB', undefined)

  expect(await withDeviceKey(callback)).toEqual({ ok: false, reason: 'storage-unavailable' })
  expect(made).not.toHaveBeenCalled()
})

test('when IndexedDB refuses to open, the result is storage-unavailable, and no key is made', async () => {
  const made = keysMade()
  vi.stubGlobal('indexedDB', refusingIndexedDB)
  vi.stubGlobal('navigator', { ...navigator, locks })

  expect(await withDeviceKey(callback)).toEqual({ ok: false, reason: 'storage-unavailable' })
  expect(made).not.toHaveBeenCalled()
})

test('when the browser denies the lock request (site data blocked), the result is storage-unavailable, not a thrown error, and no key is made', async () => {
  const made = keysMade()
  vi.stubGlobal('indexedDB', refusingIndexedDB)
  vi.stubGlobal('navigator', {
    ...navigator,
    locks: {
      request: () =>
        Promise.reject(new DOMException('The request was denied.', 'SecurityError')),
    },
  })

  expect(await withDeviceKey(callback)).toEqual({ ok: false, reason: 'storage-unavailable' })
  expect(made).not.toHaveBeenCalled()
})

test('with no Web Locks, the result is locks-unavailable, and no key is made', async () => {
  const made = keysMade()
  vi.stubGlobal('indexedDB', refusingIndexedDB)
  vi.stubGlobal('navigator', { ...navigator, locks: undefined })

  expect(await withDeviceKey(callback)).toEqual({ ok: false, reason: 'locks-unavailable' })
  expect(made).not.toHaveBeenCalled()
})
