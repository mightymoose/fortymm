import { waitFor } from '@testing-library/react'
import { expect, test } from 'vitest'
import { AppLayoutPage } from '../components/AppLayout.page.tsx'
import { DesignSystemPage } from '../components/DesignSystemLayout.page.tsx'
import { renderRoute } from '../test/render-route.tsx'

// The routes' wiring. What the page and each tab show are their own tests
// (src/components/DesignSystemLayout.test.tsx, DesignSystemTabs.test.tsx).

test('/design-system goes to its first tab, at /design-system/colour', async () => {
  const { router } = renderRoute('/design-system')

  await waitFor(() =>
    expect(router.state.location.pathname).toBe('/design-system/colour'),
  )
  expect(await new DesignSystemPage().board('Colour')).toBeVisible()
})

const tabs = [
  ['/design-system/colour', 'Colour'],
  ['/design-system/type', 'Type'],
  ['/design-system/foundations', 'Foundations'],
  ['/design-system/controls', 'Controls'],
  ['/design-system/feedback', 'Feedback'],
]

for (const [path, title] of tabs) {
  test(`${path} shows the ${title} tab inside the design system page, in the layout’s main, its tab current`, async () => {
    renderRoute(path)
    const page = new DesignSystemPage()

    expect(await page.heading()).toBeVisible()
    expect(await new AppLayoutPage().main()).toContainElement(
      await page.board(title),
    )
    expect(await page.tab(title)).toHaveAttribute('aria-current', 'page')
  })
}
