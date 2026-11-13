import { expect, test } from '@playwright/test'
import { App } from '../pages/app.ts'
import { DeviceKeyHarness } from '../pages/device-key.ts'
import { deploy } from '../pages/deployment.ts'

// This device's signing key (src/device-key.ts) in a real browser: a
// non-extractable WebCrypto P-256 key kept in IndexedDB. No screen uses it
// yet, so the tests call it through a test-only page in the "harness"
// deployment (../harness/). Each test starts from a fresh browser profile,
// with no key kept. What needs no browser (compressing the public key, the
// failure when WebCrypto, IndexedDB or Web Locks is missing) is in
// src/device-key.test.ts.

test.beforeEach(async () => {
  await deploy('harness')
})

const publicKeyShape = /^0[23][0-9a-f]{64}$/

test('the first call makes and keeps a key, and after a reload the same key comes back', async ({
  page,
}) => {
  const harness = new DeviceKeyHarness(page)
  await harness.open()
  expect(await harness.keysKept()).toBe(0)

  const first = await harness.publicKey()
  expect(first).toMatch(publicKeyShape)
  expect(await harness.keysKept()).toBe(1)

  await page.reload()
  await page.waitForFunction(() => 'deviceKeyHarness' in window)

  expect(await harness.publicKey()).toBe(first)
  expect(await harness.keysKept()).toBe(1)
})

test('asking for the kept public key makes no key: none on a fresh device, then the key the first call made', async ({
  page,
}) => {
  const harness = new DeviceKeyHarness(page)
  await harness.open()

  expect(await harness.keptPublicKey()).toBe('none')
  expect(await harness.keysKept()).toBe(0)

  const made = await harness.publicKey()
  expect(await harness.keptPublicKey()).toBe(made)
  expect(await harness.keysKept()).toBe(1)
})

test('the kept private key is a non-extractable CryptoKey, and exporting it fails', async ({
  page,
}) => {
  const harness = new DeviceKeyHarness(page)
  await harness.open()
  await harness.publicKey()

  expect(await harness.keptPrivateKey()).toEqual({
    isCryptoKey: true,
    type: 'private',
    extractable: false,
    exports: { pkcs8: 'InvalidAccessError', jwk: 'InvalidAccessError' },
  })
})

test('the public key is 33 bytes starting 02 or 03, and the core gives its account id and own player id', async ({
  page,
}) => {
  const harness = new DeviceKeyHarness(page)
  await harness.open()

  expect(await harness.publicKey()).toMatch(publicKeyShape)
  expect(await harness.coreIds()).toEqual({
    accountId: expect.stringMatching(/^[0-9a-f]{64}$/),
    ownPlayerId: expect.stringMatching(/^[0-9a-f]{64}$/),
  })
})

test('a signature, converted by the core, verifies for the signed bytes and the public key, and not for other bytes', async ({
  page,
}) => {
  const harness = new DeviceKeyHarness(page)
  await harness.open()

  expect(await harness.signAndVerify()).toEqual({
    rawLength: 64,
    verifies: true,
    verifiesOtherBytes: false,
  })
})

test('two calls at once in one page get one key', async ({ page }) => {
  const harness = new DeviceKeyHarness(page)
  await harness.open()

  const [one, other] = await harness.publicKeyTwiceAtOnce()

  expect(one).toMatch(publicKeyShape)
  expect(other).toBe(one)
  expect(await harness.publicKey()).toBe(one)
})

test('two tabs asking at once get one key', async ({ context }) => {
  const tabs = [
    new DeviceKeyHarness(await context.newPage()),
    new DeviceKeyHarness(await context.newPage()),
  ]
  await Promise.all(tabs.map((tab) => tab.open()))

  const [one, other] = await Promise.all(tabs.map((tab) => tab.publicKey()))

  expect(one).toMatch(publicKeyShape)
  expect(other).toBe(one)
  expect(await tabs[0].publicKey()).toBe(one)
})

test('when the browser can’t make a P-256 key, the result is signing-unavailable, and no key is kept', async ({
  context,
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(crypto.subtle, 'generateKey', {
      value: () =>
        Promise.reject(new DOMException('No P-256 here', 'NotSupportedError')),
    })
  })
  const harness = new DeviceKeyHarness(page)
  await harness.open()

  expect(await harness.publicKey()).toBe('failed: signing-unavailable')

  const fresh = new DeviceKeyHarness(await context.newPage())
  await fresh.open()
  expect(await fresh.keysKept()).toBe(0)
})

test('when IndexedDB refuses to store the key, the result is storage-unavailable, and no key is kept', async ({
  context,
  page,
}) => {
  await page.addInitScript(() => {
    IDBObjectStore.prototype.put = () => {
      throw new DOMException('Refused', 'DataCloneError')
    }
  })
  const harness = new DeviceKeyHarness(page)
  await harness.open()

  expect(await harness.publicKey()).toBe('failed: storage-unavailable')

  const fresh = new DeviceKeyHarness(await context.newPage())
  await fresh.open()
  expect(await fresh.keysKept()).toBe(0)
})

test('opened with no connection after one visit with one, the kept key still signs', async ({
  context,
  page,
}) => {
  const app = new App(page)
  await app.open('/')
  await app.waitUntilKept()
  const online = new DeviceKeyHarness(page)
  await online.open()
  const kept = await online.publicKey()
  await page.close()
  await context.setOffline(true)

  const offline = new DeviceKeyHarness(await context.newPage())
  await offline.open()

  expect(await offline.publicKey()).toBe(kept)
  expect(await offline.signAndVerify()).toEqual({
    rawLength: 64,
    verifies: true,
    verifiesOtherBytes: false,
  })
})
