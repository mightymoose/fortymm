import { expect, test } from 'vitest'
import { NotFoundScreenPage } from './NotFoundScreen.page.tsx'

test('the not-found screen says the page was not found, with a link to /', async () => {
  const notFound = new NotFoundScreenPage()
  notFound.render()

  expect(await notFound.heading()).toBeVisible()
  expect(await notFound.linkToStart()).toHaveAttribute('href', '/')
})
