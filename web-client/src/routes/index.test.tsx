import { expect, test } from 'vitest'
import { renderRoute } from '../test/render-route.tsx'
import { StartPage } from './index.page.ts'

test('/ shows the starter page, and its counter counts up on each click', async () => {
  const { user } = await renderRoute('/')
  const start = new StartPage(user)

  expect(await start.heading()).toBeVisible()
  expect(await start.counter()).toHaveAccessibleName('Count is 0')

  await start.clickCounter()
  await start.clickCounter()

  expect(await start.counter()).toHaveAccessibleName('Count is 2')
})
