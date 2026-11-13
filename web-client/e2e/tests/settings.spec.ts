import { expect, test } from '@playwright/test'
import { App, SettingsPage } from '../pages/app.ts'
import { deploy } from '../pages/deployment.ts'
import { DeviceKeyHarness } from '../pages/device-key.ts'
import { StorageHarness } from '../pages/storage.ts'

// /settings in the shipped app, over real IndexedDB. Nothing in the app
// stores a hello yet (the first launch will), so a test stores one through
// the storage harness page (../harness/), then opens the app's own page. The
// "harness" deployment is the production build plus those pages. Each test
// starts from a fresh browser profile.

test.beforeEach(async () => {
  await deploy('harness')
})

test('after a hello is stored, /settings opened after a reload shows the username the core gives for this device’s key', async ({
  page,
}) => {
  const harness = new StorageHarness(page)
  await harness.open()
  const { expected } = await harness.storeHello()

  await new App(page).open('/settings')

  const settings = new SettingsPage(page)
  await expect(settings.heading).toBeVisible()
  await expect(settings.username).toHaveText(expected.username)
})

test('after one visit with a connection, /settings opened with no connection shows the stored username', async ({
  context,
  page,
}) => {
  const app = new App(page)
  await app.open('/')
  await app.waitUntilKept()
  const harness = new StorageHarness(page)
  await harness.open()
  const { expected } = await harness.storeHello()
  await page.close()
  await context.setOffline(true)

  const offline = await context.newPage()
  await new App(offline).open('/settings')

  await expect(new SettingsPage(offline).username).toHaveText(expected.username)
})

test('on a fresh device, /settings says there is no account yet, and opening it makes no key and no user', async ({
  context,
  page,
}) => {
  await new App(page).open('/settings')

  await expect(new SettingsPage(page).noAccount).toBeVisible()
  const keys = new DeviceKeyHarness(await context.newPage())
  await keys.open()
  expect(await keys.keysKept()).toBe(0)
  const storage = new StorageHarness(await context.newPage())
  await storage.open()
  expect(await storage.kept()).toEqual({ records: 0, users: 0 })
})
