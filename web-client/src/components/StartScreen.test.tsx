import { expect, test } from 'vitest'
import { StartScreenPage } from './StartScreen.page.tsx'

test('the start screen is blank: no starter content, only its heading for screen readers', async () => {
  const start = new StartScreenPage()
  start.render()

  expect(await start.heading()).toBeInTheDocument()
  expect(document.body).toHaveTextContent(/^FortyMM$/)
  expect(start.images()).toEqual([])
})
