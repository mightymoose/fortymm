import { expect, test } from '@playwright/test'
import { App, SettingsPage, StartPage } from '../pages/app.ts'
import { blockedSiteData } from '../pages/blocked-site-data.ts'
import { deploy } from '../pages/deployment.ts'
import { DeviceKeyHarness } from '../pages/device-key.ts'
import { StorageHarness } from '../pages/storage.ts'

// The first launch (src/first-launch.ts), run by the shipped app at startup,
// over real IndexedDB, Web Locks and tabs. Tests open the app itself and wait
// for its launch to settle (App.firstLaunch), then look at what is kept
// through the test-only pages (../harness/). The "harness" deployment is the
// production build plus those pages. Each test starts from a fresh browser
// profile. /settings after a launch, a reload and with no connection is in
// settings.spec.ts.

test.beforeEach(async () => {
  await deploy('harness')
})

test('on a fresh device, the app’s start stores one key, one hello and one user: the user the core gives for that key', async ({
  context,
  page,
}) => {
  const app = new App(page)
  await new StartPage(page).goto()

  expect(await app.firstLaunch()).toEqual({ ok: true, outcome: 'made' })
  const keys = new DeviceKeyHarness(await context.newPage())
  await keys.open()
  expect(await keys.keysKept()).toBe(1)
  const storage = new StorageHarness(await context.newPage())
  await storage.open()
  expect(await storage.kept()).toEqual({ records: 1, users: 1 })
  const expected = await storage.expectedUser()
  expect(await storage.loadUser(expected.playerId)).toEqual({
    ok: true,
    user: { ...expected, unconfirmed: true },
  })
})

test('two tabs opening the app at once on a fresh device end up with one key, one hello and one user', async ({
  context,
}) => {
  const tabs = [await context.newPage(), await context.newPage()]

  await Promise.all(tabs.map((tab) => new StartPage(tab).goto()))
  const outcomes = await Promise.all(tabs.map((tab) => new App(tab).firstLaunch()))

  expect(outcomes).toEqual(
    expect.arrayContaining([
      { ok: true, outcome: 'made' },
      { ok: true, outcome: 'kept' },
    ]),
  )
  const keys = new DeviceKeyHarness(await context.newPage())
  await keys.open()
  expect(await keys.keysKept()).toBe(1)
  const storage = new StorageHarness(await context.newPage())
  await storage.open()
  expect(await storage.kept()).toEqual({ records: 1, users: 1 })
})

test('a key kept with no user (a launch that stopped between steps) gets its hello at the next start, from the same key', async ({
  context,
  page,
}) => {
  const keys = new DeviceKeyHarness(page)
  await keys.open()
  const kept = await keys.publicKey()
  const storage = new StorageHarness(await context.newPage())
  await storage.open()
  expect(await storage.kept()).toEqual({ records: 0, users: 0 })

  const opened = await context.newPage()
  const app = new App(opened)
  await new StartPage(opened).goto()

  expect(await app.firstLaunch()).toEqual({ ok: true, outcome: 'made' })
  expect(await keys.keysKept()).toBe(1)
  expect(await storage.kept()).toEqual({ records: 1, users: 1 })
  const expected = await storage.expectedUser()
  expect(expected.publicKey).toBe(kept)
  expect(await storage.loadUser(expected.playerId)).toMatchObject({
    ok: true,
    user: { publicKey: kept },
  })
})

test('a start on a device that already has its user stores nothing new', async ({
  context,
  page,
}) => {
  const first = new App(page)
  await new StartPage(page).goto()
  expect(await first.firstLaunch()).toEqual({ ok: true, outcome: 'made' })

  const laterPage = await context.newPage()
  const later = new App(laterPage)
  await new StartPage(laterPage).goto()

  expect(await later.firstLaunch()).toEqual({ ok: true, outcome: 'kept' })
  const storage = new StorageHarness(await context.newPage())
  await storage.open()
  expect(await storage.kept()).toEqual({ records: 1, users: 1 })
})

test('the app renders while its launch is held back, and the launch finishes once it can take the append lock', async ({
  context,
  page,
}) => {
  // Another tab holds the journal's append lock, so the launch waits.
  const holder = new DeviceKeyHarness(page)
  await holder.open()
  await holder.holdAppendLock()

  const opened = await context.newPage()
  const app = new App(opened)
  await new StartPage(opened).goto()

  await expect(new StartPage(opened).heading).toBeVisible()
  await expect.poll(() => holder.appendLocks()).toEqual({ held: 1, pending: 1 })
  const storage = new StorageHarness(await context.newPage())
  await storage.open()
  expect(await storage.kept()).toEqual({ records: 0, users: 0 })

  await holder.releaseAppendLock()

  expect(await app.firstLaunch()).toEqual({ ok: true, outcome: 'made' })
  expect(await storage.kept()).toEqual({ records: 1, users: 1 })
})

test('the start page appears while the shared core is still loading', async ({
  context,
  page,
}) => {
  // The core's module arrives 10 seconds late; the page must not wait for it.
  await context.route('**/*.wasm', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 10_000))
    await route.continue().catch(() => {})
  })

  await new StartPage(page).goto()

  await expect(new StartPage(page).heading).toBeVisible({ timeout: 3_000 })
})

test('when the browser blocks site data, the app keeps running, and the launch is storage-unavailable', async ({
  baseURL,
}) => {
  const blocked = await blockedSiteData(baseURL!)
  try {
    const page = await blocked.context.newPage()
    const app = new App(page)
    await new StartPage(page).goto()

    expect(await app.firstLaunch()).toEqual({ ok: false, reason: 'storage-unavailable' })
    await expect(new StartPage(page).heading).toBeVisible()
  } finally {
    await blocked.close()
  }
})

test('when IndexedDB refuses to store the user, the app keeps running, no hello or user is kept, and /settings says there is no account yet', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args) {
      if (this.name === 'users') throw new DOMException('Refused', 'DataCloneError')
      return put.apply(this, args)
    }
  })
  const app = new App(page)
  await new StartPage(page).goto()

  expect(await app.firstLaunch()).toEqual({ ok: false, reason: 'storage-unavailable' })
  await expect(new StartPage(page).heading).toBeVisible()
  await new SettingsPage(page).goto()
  await expect(new SettingsPage(page).noAccount).toBeVisible()
  const storage = new StorageHarness(page)
  await storage.open()
  expect(await storage.kept()).toEqual({ records: 0, users: 0 })
})

test('when the shared core doesn’t load, the app keeps running, no key, hello or user is kept, and /settings says there is no account yet', async ({
  context,
  page,
}) => {
  // Through the context, so the service worker can't fetch it either.
  await context.route('**/*.wasm', (route) => route.abort())
  const app = new App(page)
  await new StartPage(page).goto()

  expect(await app.firstLaunch()).toEqual({ ok: false, reason: 'core-unavailable' })
  await expect(new StartPage(page).heading).toBeVisible()
  await new SettingsPage(page).goto()
  await expect(new SettingsPage(page).noAccount).toBeVisible()
  const keys = new DeviceKeyHarness(page)
  await keys.open()
  expect(await keys.keysKept()).toBe(0)
  const storage = new StorageHarness(page)
  await storage.open()
  expect(await storage.kept()).toEqual({ records: 0, users: 0 })
})
