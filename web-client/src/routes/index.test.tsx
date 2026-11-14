import { expect, test } from 'vitest'
import { StartScreenPage } from '../components/StartScreen.page.tsx'
import { renderRoute } from '../test/render-route.tsx'

// The route's wiring. What the start screen shows is its own test
// (src/components/StartScreen.test.tsx).
test('/ shows the start screen', async () => {
  renderRoute('/')

  expect(await new StartScreenPage().heading()).toBeInTheDocument()
})
