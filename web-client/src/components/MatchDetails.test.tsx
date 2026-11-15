import { expect, test } from 'vitest'
import { matchStore } from '../stores/match.ts'
import { createMatch } from '../test/match.ts'
import { renderScreen } from '../test/render-screen.tsx'
import { MatchDetails } from './MatchDetails.tsx'
import { MatchDetailsScreenPage } from './match-details/MatchDetailsScreen.page.tsx'

// The match details page connected to the app's real match store (in
// memory): it shows the store's match, and a game saved while the match is
// watched (as the match layout, Match.tsx, watches it) shows with no reload;
// Score opens the next game of this match. What the screen shows for each
// match is the screen's test (match-details/MatchDetailsScreen.test.tsx).
test('the connected page shows the store’s match, a game saved while it is watched, and Score to this match’s next game', async () => {
  const matchId = await createMatch(5, [[11, 7]])
  await matchStore.getState().load(matchId)
  const stop = matchStore.getState().watchMatch(matchId)
  const page = new MatchDetailsScreenPage()
  renderScreen(<MatchDetails matchId={matchId} />, {
    path: `/matches/${matchId}`,
  })

  expect(await page.heading()).toHaveTextContent('You vs Ana')
  expect(await page.tally()).toHaveTextContent('1 – 0')
  expect(await page.score()).toHaveAttribute(
    'href',
    `/matches/${matchId}/games/2/scores/edit`,
  )

  await matchStore.getState().setGameScore(matchId, 2, [9, 11])

  await expect.poll(async () => (await page.tally()).textContent).toBe('1 – 1')
  expect(await page.score()).toHaveAttribute(
    'href',
    `/matches/${matchId}/games/3/scores/edit`,
  )
  stop()
})
