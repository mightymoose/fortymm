import { screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import type { User } from '../../storage.ts'
import { SettingsScreenPage } from './SettingsScreen.page.tsx'

// What the screen shows for each account it is handed. How the account is
// read (and that reading makes nothing) is the user store’s (src/stores/user.test.ts);
// that /settings hands the screen its loader's account is the route's
// (src/routes/settings.test.tsx); the page over real storage is the browser
// suite's (e2e/tests/settings.spec.ts).

const user: User = {
  playerId: 'ab'.repeat(32),
  accountId: 'cd'.repeat(32),
  username: 'brisk-otter-0042',
  publicKey: '02' + 'ef'.repeat(32),
  unconfirmed: true,
}

test('the settings screen has no link of its own', async () => {
  const page = new SettingsScreenPage()
  page.render({ state: 'user', user })
  await page.heading()

  expect(screen.queryAllByRole('link')).toEqual([])
})

test('the settings screen shows the username of this device’s user', async () => {
  const page = new SettingsScreenPage()
  page.render({ state: 'user', user })

  expect(await page.heading()).toBeVisible()
  expect(await page.username()).toHaveTextContent(user.username)
})

test('the settings screen says there is no account yet when this device has no user', async () => {
  const page = new SettingsScreenPage()
  page.render({ state: 'none' })

  expect(await page.noAccount()).toBeVisible()
})

test('the settings screen says it can’t read this device’s storage when the user can’t be read', async () => {
  const page = new SettingsScreenPage()
  page.render({ state: 'storage-unavailable' })

  expect(await page.storageUnavailable()).toBeVisible()
})

test('the settings screen’s pending view says it is reading this device’s account', async () => {
  const page = new SettingsScreenPage()
  page.renderPending()

  expect(await page.heading()).toBeVisible()
  expect(await page.reading()).toBeVisible()
})
