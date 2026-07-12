import { HttpResponse, delay } from 'msw'

import { buildPlayerDetail } from '@/mocks/factories/players/player-detail.factory'
import {
  buildPlayerMatchList,
  buildPlayerMatchRow,
} from '@/mocks/factories/players/player-match-row.factory'
import { waitForElementToBeRemoved } from '@/test/utilities'

import { recentMatchesPage } from './recent-matches.page'

describe('RecentMatches', () => {
  it('holds its own skeleton while the bundle loads, then paints the card', async () => {
    recentMatchesPage.mockEndpoint(async () => {
      await delay(20)
      return HttpResponse.json(
        buildPlayerDetail({
          match_total: 50,
          matches: buildPlayerMatchList([buildPlayerMatchRow()]),
        }),
      )
    })

    recentMatchesPage.render()

    await recentMatchesPage.findLoading()

    await waitForElementToBeRemoved(recentMatchesPage.queryLoading())
    expect(recentMatchesPage.getRows()).toHaveLength(1)
    expect(recentMatchesPage.getViewAllLink()).toHaveAccessibleName(
      'View all 50 matches',
    )
  })
})
