import { expect, test } from 'vitest'
import { NotFoundPage } from './__root.page.ts'

test('a URL that matches no route shows the not-found page, with a link to /', async () => {
  const notFound = new NotFoundPage()
  await notFound.render()

  expect(await notFound.heading()).toBeVisible()
  expect(await notFound.linkToStart()).toHaveAttribute('href', '/')
})
