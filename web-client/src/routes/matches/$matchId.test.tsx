import { expect, test } from 'vitest'
import { NotFoundScreenPage } from '../../components/NotFoundScreen.page.tsx'
import { createMatch } from '../../test/match.ts'
import { renderRoute } from '../../test/render-route.tsx'

// The match layout route's wiring: a match not on this device is not found,
// and no path under a match but the scoring page's has a page. That a known
// match's page shows is the scoring route's test
// ($matchId/games/$gameId/scores/edit.test.tsx); that the layout watches the
// match, src/components/Match.test.tsx.
test('a match id not on this device is not found', async () => {
  renderRoute('/matches/nope/games/1/scores/edit')

  expect(await new NotFoundScreenPage().heading()).toBeVisible()
})

test.each(['', '/games/1', '/games/1/scores'])(
  '/matches/<id>%s, a known match’s path with no page, is not found',
  async (rest) => {
    const matchId = await createMatch(5)
    renderRoute(`/matches/${matchId}${rest}`)

    expect(await new NotFoundScreenPage().heading()).toBeVisible()
  },
)
