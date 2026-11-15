import { expect, test } from '../pages/test.ts'
import { NewMatchPage } from '../pages/app.ts'

// What only a real browser can show about the new match screen
// (src/components/NewMatchScreen.tsx): closing or reloading the tab with a
// changed form asks through the browser's own prompt. Leaving it by a link
// asks in the app ("Discard changes?"), a component test. The screen asks
// nothing of the network.

test('closing the tab with a name typed asks before leaving', async ({
  page,
}) => {
  const newMatch = new NewMatchPage(page)
  await newMatch.goto()
  await newMatch.opponent.click()
  await page.keyboard.type('Ana')

  const asked = page.waitForEvent('dialog')
  await page.close({ runBeforeUnload: true })

  const dialog = await asked
  expect(dialog.type()).toBe('beforeunload')
  await dialog.accept()
})

test('closing the tab with the form as it opened asks nothing', async ({
  page,
}) => {
  const newMatch = new NewMatchPage(page)
  await newMatch.goto()
  await newMatch.opponent.click()
  let asked = false
  page.on('dialog', async (dialog) => {
    asked = true
    await dialog.accept()
  })

  await page.close({ runBeforeUnload: true })
  await expect.poll(() => page.isClosed()).toBe(true)

  expect(asked).toBe(false)
})
