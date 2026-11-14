import { within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { AppLayoutPage } from '../components/AppLayout.page.tsx'
import { DesignSystemPage } from '../components/DesignSystemLayout.page.tsx'
import { NotFoundScreenPage } from '../components/NotFoundScreen.page.tsx'
import { StartScreenPage } from '../components/StartScreen.page.tsx'
import { renderRoute } from '../test/render-route.tsx'

// The root route's wiring. What the layout and the not-found screen show are
// their own tests (src/components/AppLayout.test.tsx, Sidebar.test.tsx,
// TopBar.test.tsx, NotFoundScreen.test.tsx).
test('a screen shows inside the layout: the top bar, the sidebar, and the screen in the main landmark', async () => {
  renderRoute('/')
  const layout = new AppLayoutPage()

  expect(await layout.brand()).toBeVisible()
  expect(await layout.navigation()).toBeVisible()
  expect(
    within(await layout.main()).getByRole('heading', {
      level: 1,
      name: 'FortyMM',
    }),
  ).toBe(await new StartScreenPage().heading())
})

test('the sidebar stays collapsed when a link in it opens another page', async () => {
  const user = userEvent.setup()
  renderRoute('/')
  const layout = new AppLayoutPage()

  await user.click(await layout.sidebarToggle())
  await user.click(await layout.link('Design system'))

  expect(await new DesignSystemPage().heading()).toBeVisible()
  expect(await layout.link('Design system')).toHaveAttribute(
    'aria-current',
    'page',
  )
  expect(await layout.sidebarToggle()).toHaveAttribute('aria-expanded', 'false')
})

test('a URL that matches no route shows the not-found screen, inside the layout', async () => {
  renderRoute('/no/such/page')
  const layout = new AppLayoutPage()

  expect(
    within(await layout.main()).getByRole('heading', {
      level: 1,
      name: 'Page not found',
    }),
  ).toBe(await new NotFoundScreenPage().heading())
  expect(await layout.navigation()).toBeVisible()
})
