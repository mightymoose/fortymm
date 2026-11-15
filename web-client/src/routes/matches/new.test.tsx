import userEvent from '@testing-library/user-event'
import { screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { AppLayoutPage } from '../../components/AppLayout.page.tsx'
import { DashboardScreenPage } from '../../components/DashboardScreen.page.tsx'
import { NewMatchScreenPage } from '../../components/new-match/NewMatchScreen.page.tsx'
import { renderRoute } from '../../test/render-route.tsx'

// The route's wiring. What the screen shows and does is its own test
// (src/components/new-match/NewMatchScreen.test.tsx).
test('/matches/new shows the new match screen in the layout’s one main landmark', async () => {
  renderRoute('/matches/new')

  const heading = await new NewMatchScreenPage().heading()
  const main = await new AppLayoutPage().main()
  expect(screen.getAllByRole('main')).toEqual([main])
  expect(within(main).getByRole('heading', { level: 1 })).toBe(heading)
})

test('the route’s Start match does nothing yet: the screen stays, at /matches/new', async () => {
  const user = userEvent.setup()
  const { router } = renderRoute('/matches/new')
  const page = new NewMatchScreenPage()

  await user.type(await page.opponent(), 'Ana')
  await user.click(await page.startMatch())

  expect(router.state.location.pathname).toBe('/matches/new')
  expect(await page.heading()).toBeVisible()
})

test('Cancel on a form left as it opened goes back to the dashboard', async () => {
  const user = userEvent.setup()
  const { router } = renderRoute('/matches/new')

  await user.click(await new NewMatchScreenPage().cancel())

  expect(await new DashboardScreenPage().heading()).toBeVisible()
  expect(router.state.location.pathname).toBe('/')
})

test('on a changed form, Discard & leave goes where it was asked to, the dashboard; Keep editing stays', async () => {
  const user = userEvent.setup()
  const { router } = renderRoute('/matches/new')
  const page = new NewMatchScreenPage()
  await user.type(await page.opponent(), 'Ana')

  await user.click(await page.cancel())
  await user.click(await page.keepEditing())
  expect(router.state.location.pathname).toBe('/matches/new')

  await user.click(await page.cancel())
  await user.click(await page.discardAndLeave())

  expect(await new DashboardScreenPage().heading()).toBeVisible()
  expect(router.state.location.pathname).toBe('/')
})
