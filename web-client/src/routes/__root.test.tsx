import { expect, test } from 'vitest'
import { renderRoute } from '../test/render-route.tsx'
import { NotFoundPage } from './__root.page.ts'

test('a URL that matches no route shows the not-found page, with a link to /', async () => {
  await renderRoute('/no/such/page')
  const notFound = new NotFoundPage()

  expect(await notFound.heading()).toBeVisible()
  expect(await notFound.linkToStart()).toHaveAttribute('href', '/')
})
