import { expect, test } from '@playwright/test'
import { App, StartPage } from '../pages/app.ts'
import { deploy } from '../pages/deployment.ts'
import { DeviceKeyHarness } from '../pages/device-key.ts'
import { StorageHarness } from '../pages/storage.ts'

// Storage of records and the users they mint (src/storage.ts) against real
// IndexedDB. No screen writes with it, so the tests call it through a
// test-only page in the "harness" deployment (../harness/), which makes a
// hello with the core and this device's key. Each test starts from a fresh
// browser profile. What needs no browser (the records refused, the failures
// when IndexedDB or Web Locks is missing) is in src/storage.test.ts.

test.beforeEach(async () => {
  await deploy('harness')
})

test('a stored hello gives the user with the player id, account id, username and key the core gives for its key, unconfirmed', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()

  const { results, expected } = await harness.storeHello()

  expect(results).toEqual([{ ok: true }])
  expect(await harness.loadUser(expected.playerId)).toEqual({
    ok: true,
    user: { ...expected, unconfirmed: true },
  })
})

test('the stored user is still there after a reload', async ({ page }) => {
  const harness = new StorageHarness(page)
  await harness.open()
  const { expected } = await harness.storeHello()

  await page.reload()
  await page.waitForFunction(() => 'storageHarness' in window)

  expect(await harness.loadUser(expected.playerId)).toEqual({
    ok: true,
    user: { ...expected, unconfirmed: true },
  })
})

test('opened with no connection after one visit with one, the stored user is there', async ({
  context,
  page,
}) => {
  const app = new App(page)
  await new StartPage(page).goto()
  await app.waitUntilKept()
  const online = new StorageHarness(page)
  await online.open()
  const { expected } = await online.storeHello()
  await page.close()
  await context.setOffline(true)

  const offline = new StorageHarness(await context.newPage())
  await offline.open()

  expect(await offline.loadUser(expected.playerId)).toEqual({
    ok: true,
    user: { ...expected, unconfirmed: true },
  })
})

test('storing the same hello twice keeps one record and one user, with no error', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()

  const { results } = await harness.storeHello(2)

  expect(results).toEqual([{ ok: true }, { ok: true }])
  expect(await harness.kept()).toEqual({ records: 1, users: 1 })
})

test('storeRecord keeps the bytes it verified, even when the caller changes its array while the store waits for the lock', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()

  const { result, signed, kept } = await harness.storeWhileCallerChangesIt()

  expect(result).toEqual({ ok: true })
  expect(kept.hex).toBe(signed)
})

test('storeRecord keeps a tight copy of a record given as a view into a larger buffer', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()

  const { result, signed, length, kept } = await harness.storeAsSlice()

  expect(result).toEqual({ ok: true })
  expect(kept).toEqual({ hex: signed, byteLength: length, bufferByteLength: length })
})

test('a second valid record with an id already kept leaves the first record’s bytes, with no error', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()

  const { results, first, second, kept, counts } =
    await harness.storeTwoSignaturesOfOneBody()

  expect(second).not.toBe(first)
  expect(results).toEqual([{ ok: true }, { ok: true }])
  expect(kept.hex).toBe(first)
  expect(counts).toEqual({ records: 1, users: 1 })
})

test('when writing the user fails, the hello isn’t kept either: storing is storage-unavailable', async ({
  context,
  page,
}) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args) {
      if (this.name === 'users') throw new DOMException('Refused', 'DataCloneError')
      return put.apply(this, args)
    }
  })
  const harness = new StorageHarness(page)
  await harness.open()

  const { results } = await harness.storeHello()

  expect(results).toEqual([{ ok: false, reason: 'storage-unavailable' }])
  const fresh = new StorageHarness(await context.newPage())
  await fresh.open()
  expect(await fresh.kept()).toEqual({ records: 0, users: 0 })
})

test('a hello stored as this device’s own is what loadMe gives: the user the core gives for its key', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()

  const { result, expected } = await harness.storeOwnHello()

  expect(result).toEqual({ ok: true })
  expect(await harness.loadMe()).toEqual({
    ok: true,
    user: { ...expected, unconfirmed: true },
  })
})

test('a hello stored with the public storeRecord is not this device’s own: loadMe gives none', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()
  await harness.storeHello()

  expect(await harness.loadMe()).toEqual({ ok: true, user: null })
})

test('on a fresh device, loadMe gives no user, and makes no key, record or user', async ({
  context,
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()

  expect(await harness.loadMe()).toEqual({ ok: true, user: null })
  expect(await harness.kept()).toEqual({ records: 0, users: 0 })
  const keys = new DeviceKeyHarness(await context.newPage())
  await keys.open()
  expect(await keys.keysKept()).toBe(0)
})

test('when writing the me pointer fails, neither the hello nor the user is kept, and loadMe gives none', async ({
  context,
  page,
}) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args) {
      if (this.name === 'me') throw new DOMException('Refused', 'DataCloneError')
      return put.apply(this, args)
    }
  })
  const harness = new StorageHarness(page)
  await harness.open()

  const { result } = await harness.storeOwnHello()

  expect(result).toEqual({ ok: false, reason: 'storage-unavailable' })
  const fresh = new StorageHarness(await context.newPage())
  await fresh.open()
  expect(await fresh.kept()).toEqual({ records: 0, users: 0 })
  expect(await fresh.loadMe()).toEqual({ ok: true, user: null })
})

test('loading a player that isn’t stored gives no user, not a failure', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()
  await harness.storeHello()

  expect(await harness.loadUser('ab'.repeat(32))).toEqual({ ok: true, user: null })
})
