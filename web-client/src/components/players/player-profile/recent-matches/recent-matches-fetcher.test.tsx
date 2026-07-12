import { HttpResponse, delay } from 'msw'

import { buildPlayerDetail } from '@/mocks/factories/players/player-detail.factory'
import {
  buildLiveMatchRow,
  buildPlayerMatchList,
  buildPlayerMatchRow,
} from '@/mocks/factories/players/player-match-row.factory'
import { waitForElementToBeRemoved } from '@/test/utilities'

import { recentMatchesFetcherPage } from './recent-matches-fetcher.page'

describe('RecentMatchesFetcher', () => {
  it('suspends until the bundle resolves, then paints the rows it carries', async () => {
    // The rows come from the bundle itself — the card never calls the paginated
    // matches endpoint (which this page object deliberately leaves unstubbed:
    // MSW errors on an unhandled request).
    recentMatchesFetcherPage.mockEndpoint(async () => {
      await delay(20)
      return HttpResponse.json(
        buildPlayerDetail({
          match_total: 50,
          matches: buildPlayerMatchList([
            buildPlayerMatchRow({
              opponent: { id: 'p-9', username: 'ada.lovelace' },
            }),
            buildLiveMatchRow({ opponent: { id: 'p-8', username: 'kai.zhou' } }),
          ]),
        }),
      )
    })

    recentMatchesFetcherPage.render()

    // The router paints asynchronously, so the pending state is awaited, not
    // asserted synchronously.
    await recentMatchesFetcherPage.findLoading()

    await waitForElementToBeRemoved(recentMatchesFetcherPage.queryLoading())

    expect(recentMatchesFetcherPage.getRows()).toHaveLength(2)
    expect(
      recentMatchesFetcherPage.getStatusDot('kai.zhou'),
    ).toHaveAccessibleName('Live')
    expect(recentMatchesFetcherPage.getViewAllLink()).toHaveAccessibleName(
      'View all 50 matches',
    )
  })

  it('propagates a failed bundle to the ancestor error boundary', async () => {
    // No per-card boundary by design: every card shares this one query.
    recentMatchesFetcherPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    )

    recentMatchesFetcherPage.render()

    expect(await recentMatchesFetcherPage.findError()).toBeInTheDocument()
    expect(recentMatchesFetcherPage.queryLoading()).not.toBeInTheDocument()
  })
})
