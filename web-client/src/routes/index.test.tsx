import { userEvent } from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { healthy } from '../test/api/health.ts'
import { server } from '../test/api/server.ts'
import { HealthPage } from './health.page.ts'
import { StartPage } from './index.page.ts'
import { SettingsPage } from './settings.page.ts'

test('/ shows the starter page, and its counter counts up on each click', async () => {
  const user = userEvent.setup()
  const start = new StartPage()
  await start.render()

  expect(await start.heading()).toBeVisible()
  expect(await start.counter()).toHaveAccessibleName('Count is 0')

  await user.click(await start.counter())
  await user.click(await start.counter())

  expect(await start.counter()).toHaveAccessibleName('Count is 2')
})

test('/ links to the health page, at /health', async () => {
  server.use(healthy())
  const user = userEvent.setup()
  const start = new StartPage()
  const health = new HealthPage()
  await start.render()

  expect(await start.linkToHealth()).toHaveAttribute('href', '/health')
  await user.click(await start.linkToHealth())

  expect(await health.heading()).toBeVisible()
})

test('/ links to the account settings page, at /settings', async () => {
  const user = userEvent.setup()
  const start = new StartPage()
  const settings = new SettingsPage()
  await start.render()

  expect(await start.linkToSettings()).toHaveAttribute('href', '/settings')
  await user.click(await start.linkToSettings())

  expect(await settings.heading()).toBeVisible()
})
