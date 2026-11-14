import { expect, test } from 'vitest'
import { DesignSystemScreenPage } from '../components/DesignSystemScreen.page.tsx'
import { renderRoute } from '../test/render-route.tsx'

// The route's wiring. What the design system screen shows is its own test
// (src/components/DesignSystemScreen.test.tsx).
test('/design-system shows the design system screen', async () => {
  renderRoute('/design-system')

  expect(await new DesignSystemScreenPage().heading()).toBeVisible()
})
