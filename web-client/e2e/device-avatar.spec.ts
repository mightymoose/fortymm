import { expect, test } from '@playwright/test'
import { AppLayoutPage } from './app-layout.page.ts'

// The device's avatar in the top bar, worked out from its key (src/device/whoami.ts). Making the
// key needs WebCrypto, so this spec runs in a secure context (playwright.config.ts). Each test has
// a fresh browser context: a new device.

test('is named by a generated username', async ({ page }) => {
  const layout = new AppLayoutPage(page)
  await layout.gotoOnDesktop()
  expect(await layout.findUsername()).toMatch(/^[a-z]+-[a-z]+-[0-9bcdfghjkmnpqrstvwxz]{4}$/)
})

test("shows the first letters of the username's first two words", async ({ page }) => {
  const layout = new AppLayoutPage(page)
  await layout.gotoOnDesktop()
  const [adjective, animal] = (await layout.findUsername()).split('-')
  await expect(layout.avatar).toHaveText(`${adjective![0]}${animal![0]}`.toUpperCase())
})

test('keeps its username after a reload', async ({ page }) => {
  const layout = new AppLayoutPage(page)
  await layout.gotoOnDesktop()
  const first = await layout.findUsername()
  await page.reload()
  expect(await layout.findUsername()).toBe(first)
})

test('has one username in every tab', async ({ context }) => {
  const layouts = await Promise.all(
    Array.from({ length: 3 }, async () => new AppLayoutPage(await context.newPage())),
  )
  await Promise.all(layouts.map((layout) => layout.gotoOnDesktop()))
  const usernames = await Promise.all(layouts.map((layout) => layout.findUsername()))
  expect(new Set(usernames).size).toBe(1)
})

test('leaves the brand centred on a phone', async ({ page }) => {
  const layout = new AppLayoutPage(page)
  await layout.gotoOnPhone()
  await layout.avatar.waitFor()
  expect(await layout.brandOffCentre()).toBeLessThan(1)
})

test('shows the whole username beside it on a desktop', async ({ page }) => {
  const layout = new AppLayoutPage(page)
  await layout.gotoOnDesktop()
  await expect(layout.shownUsername).toHaveText(await layout.findUsername())
})

test('shows only the initials on a phone', async ({ page }) => {
  const layout = new AppLayoutPage(page)
  await layout.gotoOnPhone()
  await layout.findUsername()
  await expect(layout.shownUsername).toBeHidden()
})
