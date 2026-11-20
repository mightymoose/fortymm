import userEvent from '@testing-library/user-event'
import { expect, onTestFinished, test } from 'vitest'
import { DashboardScreenPage } from '../../components/DashboardScreen.page.tsx'
import type { Score } from '../../scoring/scoring.ts'
import { MatchDetailsScreenPage } from '../../components/match-details/MatchDetailsScreen.page.tsx'
import { MatchUnavailableScreenPage } from '../../components/match/MatchUnavailableScreen.page.tsx'
import { NotFoundScreenPage } from '../../components/NotFoundScreen.page.tsx'
import { ScoringScreenPage } from '../../components/scoring/ScoringScreen.page.tsx'
import { matchMemory } from '../../test/match-memory.ts'
import { createMatch } from '../../test/match.ts'
import { renderRoute } from '../../test/render-route.tsx'

// The match layout route's wiring: a match not on this device is not found,
// one the device won't read says so (MatchUnavailableScreen) and is read
// again through the routes' loaders, and no path under a match but its
// details page's and the scoring page's has a page. That a known match's
// pages show is their routes' tests
// ($matchId/index.test.tsx, $matchId/games/$gameId/scores/edit.test.tsx); that
// the layout watches the match, src/components/Match.test.tsx.
test('a match id not on this device is not found', async () => {
  renderRoute('/matches/nope/games/1/scores/edit')

  expect(await new NotFoundScreenPage().heading()).toBeVisible()
})

test.each([
  { page: 'details page', rest: '' },
  { page: 'scoring page', rest: '/games/1/scores/edit' },
])(
  'a match the device won’t read says it couldn’t be loaded on its $page, not that it isn’t found',
  async ({ rest }) => {
    const matchId = await createMatch(5)
    onTestFinished(matchMemory.failReads('storage-unavailable'))
    renderRoute(`/matches/${matchId}${rest}`)

    const page = new MatchUnavailableScreenPage()
    expect(await page.heading()).toBeVisible()
    expect(await page.alert()).toBeVisible()
    expect(new NotFoundScreenPage().headingNow()).toBeNull()
  },
)

test('Try again, once the device reads the match, opens the page asked for', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5)
  const readable = matchMemory.failReads('core-unavailable')
  onTestFinished(readable)
  renderRoute(`/matches/${matchId}/games/1/scores/edit`)
  const page = new MatchUnavailableScreenPage()
  await page.alert()

  readable()
  await user.click(await page.tryAgain())

  expect(await new ScoringScreenPage().heading()).toHaveTextContent('Enter game 1 score.')
  expect(page.alertNow()).toBeNull()
})

// The scoring page's own guard (which game may open) runs in its loader,
// after the layout's read: a retry that worked must not show the scoring
// form for a game the guard then refuses.
test.each([
  { name: 'game 9 of a best of 5, not found', bestOf: 5 as const, games: [], game: 9, end: 'not found' },
  {
    name: 'an empty game 3 of a decided best of 3, the dashboard',
    bestOf: 3 as const,
    games: [
      [11, 1],
      [11, 2],
    ] as Score[],
    game: 3,
    end: 'dashboard',
  },
])('Try again on $name never shows that game’s scoring form on the way', async ({ bestOf, games, game, end }) => {
  const user = userEvent.setup()
  const matchId = await createMatch(bestOf, games)
  const readable = matchMemory.failReads('storage-unavailable')
  onTestFinished(readable)
  renderRoute(`/matches/${matchId}/games/${game}/scores/edit`)
  const page = new MatchUnavailableScreenPage()
  await page.alert()
  const seen = headingsShown()

  readable()
  await user.click(await page.tryAgain())

  if (end === 'not found') await new NotFoundScreenPage().heading()
  else await new DashboardScreenPage().heading()
  expect(seen.filter((text) => /game \d+ score/.test(text))).toEqual([])
})

// Every <h1> text the page shows from now on, in order.
function headingsShown() {
  const seen: string[] = []
  const observer = new MutationObserver(() => {
    for (const heading of document.querySelectorAll('h1')) seen.push(heading.textContent ?? '')
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  onTestFinished(() => observer.disconnect())
  return seen
}

test('a match the device wouldn’t read is read again when the page is shown again', async () => {
  const matchId = await createMatch(5)
  const readable = matchMemory.failReads('storage-unavailable')
  onTestFinished(readable)
  renderRoute(`/matches/${matchId}`)
  const page = new MatchUnavailableScreenPage()
  await page.alert()

  readable()
  document.dispatchEvent(new Event('visibilitychange'))

  expect(await new MatchDetailsScreenPage().heading()).toBeVisible()
  expect(page.alertNow()).toBeNull()
})

// The user's decision (2026-11-16): only the first read's refusal shows; a
// later one leaves the page as it is.
test('a later read of an open match the device refuses leaves its page and the score typed as they are', async () => {
  const user = userEvent.setup()
  const matchId = await createMatch(5)
  renderRoute(`/matches/${matchId}/games/1/scores/edit`)
  const scoring = new ScoringScreenPage()
  await scoring.heading()
  await user.keyboard('11{Enter}7')

  matchMemory.failNextRead('storage-unavailable')
  matchMemory.announceAll()
  await new Promise((settled) => setTimeout(settled, 50))

  expect(new MatchUnavailableScreenPage().alertNow()).toBeNull()
  expect(await scoring.yours()).toHaveValue('11')
  expect(await scoring.theirs()).toHaveValue('7')
})

// A read now would be refused: a match read again would swap the page for
// "couldn't load this match".
test('a match already read is not read again when the page is shown again', async () => {
  const matchId = await createMatch(5)
  renderRoute(`/matches/${matchId}`)
  const details = new MatchDetailsScreenPage()
  await details.heading()
  matchMemory.failNextRead('storage-unavailable')
  // The armed refusal is used up by this read, so no later test gets it.
  onTestFinished(async () => void (await matchMemory.read(matchId)))

  document.dispatchEvent(new Event('visibilitychange'))
  await new Promise((settled) => setTimeout(settled, 50))

  expect(await details.heading()).toBeVisible()
  expect(new MatchUnavailableScreenPage().alertNow()).toBeNull()
})

test.each(['/games/1', '/games/1/scores'])(
  '/matches/<id>%s, a known match’s path with no page, is not found',
  async (rest) => {
    const matchId = await createMatch(5)
    renderRoute(`/matches/${matchId}${rest}`)

    expect(await new NotFoundScreenPage().heading()).toBeVisible()
  },
)
