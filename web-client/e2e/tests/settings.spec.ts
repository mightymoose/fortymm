import { expect, test } from '@playwright/test'
import { App, SettingsPage, StartPage } from '../pages/app.ts'
import { deploy } from '../pages/deployment.ts'
import { DeviceKeyHarness } from '../pages/device-key.ts'
import { StorageHarness } from '../pages/storage.ts'

// /settings in the shipped app, over real IndexedDB, after the app's own
// first launch (src/first-launch.ts) stored this device's hello. The
// "harness" deployment is the production build plus test-only pages
// (../harness/), through which a test reads what the core gives for the key
// and counts what is kept. Each test starts from a fresh browser profile.
// The launch itself (one key, hello and user; two tabs; failures) is in
// first-launch.spec.ts.

test.beforeEach(async () => {
  await deploy('harness')
})

test('after the app’s first start, /settings shows the username the core gives for this device’s key', async ({
  context,
  page,
}) => {
  const app = new App(page)
  await new StartPage(page).goto()
  await app.firstLaunch()

  await new SettingsPage(page).goto()

  const settings = new SettingsPage(page)
  await expect(settings.heading).toBeVisible()
  const storage = new StorageHarness(await context.newPage())
  await storage.open()
  const { username } = await storage.expectedUser()
  await expect(settings.username).toHaveText(username)
})

test('after a reload, and opened with no connection after one visit, /settings shows the same username, from the same key and the one hello', async ({
  context,
  page,
}) => {
  const app = new App(page)
  await new StartPage(page).goto()
  expect(await app.firstLaunch()).toEqual({ ok: true, outcome: 'made' })
  await app.waitUntilKept()
  await new SettingsPage(page).goto()
  const username = await new SettingsPage(page).username.textContent()
  expect(username).toMatch(/\S/)
  const keys = new DeviceKeyHarness(await context.newPage())
  await keys.open()
  const key = await keys.keptPublicKey()

  await page.reload()
  expect(await app.firstLaunch()).toEqual({ ok: true, outcome: 'kept' })
  await expect(new SettingsPage(page).username).toHaveText(username!)

  for (const open of context.pages()) await open.close()
  await context.setOffline(true)
  const offline = await context.newPage()
  const offlineApp = new App(offline)
  await new SettingsPage(offline).goto()

  await expect(new SettingsPage(offline).username).toHaveText(username!)
  expect(await offlineApp.firstLaunch()).toEqual({ ok: true, outcome: 'kept' })
  const offlineKeys = new DeviceKeyHarness(await context.newPage())
  await offlineKeys.open()
  expect(await offlineKeys.keptPublicKey()).toBe(key)
  expect(await offlineKeys.keysKept()).toBe(1)
  const storage = new StorageHarness(await context.newPage())
  await storage.open()
  expect(await storage.kept()).toEqual({ records: 1, users: 1 })
})
