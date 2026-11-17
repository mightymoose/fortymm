import userEvent from '@testing-library/user-event'
import { screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { AppLayoutPage } from '../../components/AppLayout.page.tsx'
import { DashboardScreenPage } from '../../components/DashboardScreen.page.tsx'
import { NewMatchScreenPage } from '../../components/new-match/NewMatchScreen.page.tsx'
import { ScoringScreenPage } from '../../components/scoring/ScoringScreen.page.tsx'
import { matchMemory } from '../../stores/match-memory.ts'
import { matchesStore } from '../../stores/matches.ts'
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

test('Start match opens game 1’s scoring page for the new match, asking nothing', async () => {
  const user = userEvent.setup()
  const { router } = renderRoute('/matches/new')
  const page = new NewMatchScreenPage()

  await user.click(await page.bestOf(3))
  await user.click(await page.startMatch())

  const scoring = new ScoringScreenPage()
  expect(await scoring.theirs()).toBeVisible()
  expect(await scoring.heading()).toHaveTextContent('Enter game 1 score.')
  await matchesStore.getState().load()
  const matches = matchesStore.getState().matches
  if (matches.status !== 'ready') throw new Error(`list ${matches.status}`)
  expect(matches.matches[0]).toMatchObject({ bestOf: 3, rated: false })
  expect(router.state.location.pathname).toBe(
    `/matches/${matches.matches[0]!.matchId}/games/1/scores/edit`,
  )
  expect(page.queryDiscardDialog()).toBeNull()
})

test('Back from the scoring page Start match opened goes where the person was before the form', async () => {
  const user = userEvent.setup()
  const { router } = renderRoute('/')
  await new DashboardScreenPage().heading()
  await router.navigate({ to: '/matches/new' })
  const page = new NewMatchScreenPage()

  await user.click(await page.bestOf(7))
  await user.click(await page.startMatch())
  await new ScoringScreenPage().theirs()
  router.history.back()

  expect(await new DashboardScreenPage().heading()).toBeVisible()
  expect(router.state.location.pathname).toBe('/')
})

test('a create the device refused stays on the form, as filled, with its alert, asking nothing', async () => {
  const user = userEvent.setup()
  const { router } = renderRoute('/matches/new')
  const page = new NewMatchScreenPage()
  matchMemory.failNextWrite('storage-unavailable')
  await user.click(await page.bestOf(7))
  await user.click(await page.startMatch())

  expect(await page.alert()).toHaveTextContent('Couldn’t start the match')
  // Past any navigation the answer would have started.
  await new Promise((settled) => setTimeout(settled, 50))
  expect(router.state.location.pathname).toBe('/matches/new')
  expect(await page.bestOf(7)).toBeChecked()
  expect(page.queryDiscardDialog()).toBeNull()
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
  await user.click(await page.bestOf(7))

  await user.click(await page.cancel())
  await user.click(await page.keepEditing())
  expect(router.state.location.pathname).toBe('/matches/new')

  await user.click(await page.cancel())
  await user.click(await page.discardAndLeave())

  expect(await new DashboardScreenPage().heading()).toBeVisible()
  expect(router.state.location.pathname).toBe('/')
})
