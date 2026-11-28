import { expect, test } from '@playwright/test'
import { DevicePage } from './device.page.ts'

// The device key (J6, design 4.4 and 5.4) and persistent storage, made and asked for when someone
// lands on the page. Each test has a fresh browser context: a new device.

test('landing on a new device makes its key', async ({ page }) => {
  const device = new DevicePage(page)
  await device.goto()
  expect(await device.findDeviceKeyMark()).toEqual({ ok: true, outcome: 'made' })
})

test("the key's private half cannot be exported", async ({ page }) => {
  const device = new DevicePage(page)
  await device.goto()
  expect((await device.findSigningKey()).privateKeyExtractable).toBe(false)
})

test('landing again keeps the key that was made', async ({ page }) => {
  const device = new DevicePage(page)
  await device.goto()
  await device.findDeviceKeyMark()
  await device.reload()
  expect(await device.findDeviceKeyMark()).toEqual({ ok: true, outcome: 'kept' })
})

test('landing again keeps the same public key', async ({ page }) => {
  const device = new DevicePage(page)
  await device.goto()
  const first = await device.findSigningKey()
  await device.reload()
  expect((await device.findSigningKey()).publicKey).toBe(first.publicKey)
})

test('several tabs landing at once make exactly one key', async ({ context }) => {
  const devices = await Promise.all(
    Array.from({ length: 5 }, async () => new DevicePage(await context.newPage())),
  )
  await Promise.all(devices.map((device) => device.goto()))
  const marks = await Promise.all(devices.map((device) => device.findDeviceKeyMark()))
  expect(marks.filter((mark) => mark.ok && mark.outcome === 'made')).toHaveLength(1)
})

test('landing asks the browser to keep the site storage', async ({ page }) => {
  const device = new DevicePage(page)
  await device.countPersistRequests()
  await device.goto()
  expect(await device.findPersistRequests()).toBe(1)
})
