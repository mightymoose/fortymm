import { expect, test } from '@playwright/test'
import { NotFoundPage } from './pages/not-found-page.ts'

// Wiring for any URL but `/`: the server answers a deep path with the app, and
// the router, not the server, decides what it shows. The only such URL today
// is one with no route, so this loads one and expects the not-found page.
test('a non-root URL loaded directly is handled by the router', async ({
  page,
}) => {
  const pageErrors: Error[] = []
  page.on('pageerror', (error) => pageErrors.push(error))
  const notFound = new NotFoundPage(page)

  await notFound.open('/no/such/page')

  await expect(page).toHaveTitle('web-client')
  await expect(notFound.heading).toBeVisible()
  expect(pageErrors).toEqual([])
})
