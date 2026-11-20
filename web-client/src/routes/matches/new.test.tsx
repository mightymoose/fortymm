import userEvent from '@testing-library/user-event'
import { screen, within } from '@testing-library/react'
import { expect, onTestFinished, test, vi } from 'vitest'
import { AppLayoutPage } from '../../components/AppLayout.page.tsx'
import { DashboardScreenPage } from '../../components/DashboardScreen.page.tsx'
import { NewMatchScreenPage } from '../../components/new-match/NewMatchScreen.page.tsx'
import { ScoringScreenPage } from '../../components/scoring/ScoringScreen.page.tsx'
import { matchMemory } from '../../test/match-memory.ts'
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

// Black-box #12: the new match form's leave guard must not outlive Start.
// Whether the browser would ask before the page goes (a leave guard's
// beforeunload handler cancels the event).
function unloadAsks() {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

test.each([1, 3, 7])(
  'after Start match with best of %i, game 1 with nothing typed doesn’t ask the browser before leaving',
  async (bestOf) => {
    const user = userEvent.setup()
    renderRoute('/matches/new', { browserHistory: true })
    const page = new NewMatchScreenPage()
    await user.click(await page.bestOf(bestOf))
    expect(unloadAsks()).toBe(true)

    await user.click(await page.startMatch())

    expect(await new ScoringScreenPage().heading()).toHaveTextContent('Enter game 1 score.')
    expect(unloadAsks()).toBe(false)
  },
)

// Black-box #17: digits typed straight after Start, before game 1's page has
// opened (the match is still being kept), aren't lost.
test('a score typed straight after Start match, while the match is being kept, is in game 1’s fields once it opens', async () => {
  const user = userEvent.setup()
  renderRoute('/matches/new')
  const page = new NewMatchScreenPage()
  await page.heading()
  const release = matchMemory.holdNextWrite()

  await user.click(await page.startMatch())
  await user.keyboard('11{Enter}7')
  release()

  const scoring = new ScoringScreenPage()
  expect(await scoring.heading()).toHaveTextContent('Enter game 1 score.')
  await vi.waitFor(async () => expect(await scoring.yours()).toHaveValue('11'))
  expect(await scoring.theirs()).toHaveValue('7')
  expect(await scoring.theirs()).toHaveFocus()
  // Typing on goes on where it left off.
  await user.keyboard('2')
  expect(await scoring.theirs()).toHaveValue('72')
})

test('keys typed after a Start match the device refused stay on the form, and nothing is kept for later', async () => {
  const user = userEvent.setup()
  renderRoute('/matches/new')
  const page = new NewMatchScreenPage()
  await page.heading()
  matchMemory.failNextWrite('storage-unavailable')

  await user.click(await page.startMatch())
  await page.alert()
  // Keys work on the form as ever: none are kept from it.
  const start = await page.startMatch()
  start.focus()
  await user.tab()
  expect(start).not.toHaveFocus()
  await user.keyboard('11')
  await user.click(await page.startMatch())

  const scoring = new ScoringScreenPage()
  expect(await scoring.heading()).toHaveTextContent('Enter game 1 score.')
  expect(await scoring.yours()).toHaveValue('')
})

// Round 4, bug 1 (interrogate-g2c): a Start still on its way when the person
// leaves for another page. The match is kept; the person stays where they
// went, and what they type there is theirs, never the new match's.
test('Start match that answers after the person left for another page leaves them there, and keys typed there stay out of the new match', async () => {
  const user = userEvent.setup()
  const { router } = renderRoute('/matches/new')
  const page = new NewMatchScreenPage()
  await page.heading()
  await matchesStore.getState().load()
  const before = matchesStore.getState().matches
  if (before.status !== 'ready') throw new Error(`list ${before.status}`)
  const release = matchMemory.holdNextWrite()
  onTestFinished(release)

  await user.click(await page.startMatch())
  await user.click(await new AppLayoutPage().brand())
  expect(await new DashboardScreenPage().heading()).toBeVisible()
  await user.keyboard('4{Tab}2')
  release()

  let matchId = ''
  await vi.waitFor(async () => {
    await matchesStore.getState().load()
    const after = matchesStore.getState().matches
    if (after.status !== 'ready') throw new Error(`list ${after.status}`)
    expect(after.matches).toHaveLength(before.matches.length + 1)
    matchId = after.matches[0]!.matchId
  })
  await new Promise((resolve) => setTimeout(resolve))
  expect(router.state.location.pathname).toBe('/')

  await router.navigate({
    to: '/matches/$matchId/games/$gameId/scores/edit',
    params: { matchId, gameId: '1' },
  })
  const scoring = new ScoringScreenPage()
  expect(await scoring.heading()).toHaveTextContent('Enter game 1 score.')
  expect(await scoring.yours()).toHaveValue('')
  expect(await scoring.theirs()).toHaveValue('')
})
