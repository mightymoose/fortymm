import { expect, test } from 'vitest'
import { StartPage } from './index.page.ts'

test('/ is blank: no starter content, only its heading for screen readers', async () => {
  const start = new StartPage()
  await start.render()

  expect(await start.heading()).toBeInTheDocument()
  expect(document.body).toHaveTextContent(/^FortyMM$/)
  expect(start.images()).toEqual([])
})
