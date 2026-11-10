import { userEvent } from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { StartPage } from './index.page.ts'

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
