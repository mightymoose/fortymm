import { expect, test } from 'vitest'
import { NotFoundScreenPage } from '../components/NotFoundScreen.page.tsx'
import { renderRoute } from '../test/render-route.tsx'

// The root route's wiring. What the not-found screen shows is its own test
// (src/components/NotFoundScreen.test.tsx).
test('a URL that matches no route shows the not-found screen', async () => {
  renderRoute('/no/such/page')

  expect(await new NotFoundScreenPage().heading()).toBeVisible()
})
