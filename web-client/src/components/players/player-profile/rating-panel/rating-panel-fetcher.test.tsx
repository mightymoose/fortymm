import { HttpResponse } from 'msw'

import {
  buildJustRatedPlayerDetail,
  buildPlayerDetail,
  buildUnratedPlayerDetail,
} from '@/mocks/factories/players/player-detail.factory'
import { waitForElementToBeRemoved } from '@/test/utilities'

import { ratingPanelFetcherPage } from './rating-panel-fetcher.page'

describe('RatingPanelFetcher', () => {
  it('suspends, then paints the standing the bundle carries', async () => {
    ratingPanelFetcherPage.mockEndpoint(() =>
      HttpResponse.json(
        buildPlayerDetail({ rating: 1687, rank: 3, rank_of: 42, peak: 1712 }),
      ),
    )

    ratingPanelFetcherPage.render()

    expect(ratingPanelFetcherPage.queryLoading()).toBeInTheDocument()

    await waitForElementToBeRemoved(ratingPanelFetcherPage.queryLoading())
    expect(ratingPanelFetcherPage.getRating()).toHaveTextContent('1687')
    expect(ratingPanelFetcherPage.queryStat('Rank')).toHaveTextContent(
      '#3 of 42',
    )
    expect(ratingPanelFetcherPage.queryStat('Peak')).toHaveTextContent('1712')
    expect(ratingPanelFetcherPage.getChips()).toHaveLength(10)
  })

  it('shows an unrated player as Unrated, with no rank', async () => {
    ratingPanelFetcherPage.mockEndpoint(() =>
      HttpResponse.json(buildUnratedPlayerDetail()),
    )

    ratingPanelFetcherPage.render()

    await waitForElementToBeRemoved(ratingPanelFetcherPage.queryLoading())
    expect(ratingPanelFetcherPage.getRating()).toHaveTextContent('Unrated')
    expect(ratingPanelFetcherPage.queryStat('Rank')).toBeNull()
    expect(ratingPanelFetcherPage.queryDelta()).not.toBeInTheDocument()
  })

  it('shows a just-rated player their new rating and NO delta chip', async () => {
    // Their first rated match ESTABLISHED this rating (a present `rating_delta`
    // whose `delta` is null) — it did not move one. So the hero prints the
    // number, and the chip is suppressed: they did not gain 1268 and they
    // certainly did not lose 232 off the 1500 their league-join seeded (#952).
    ratingPanelFetcherPage.mockEndpoint(() =>
      HttpResponse.json(buildJustRatedPlayerDetail()),
    )

    ratingPanelFetcherPage.render()

    await waitForElementToBeRemoved(ratingPanelFetcherPage.queryLoading())
    // Unlike the unrated player above, this one HAS a rating — the two null
    // deltas must not collapse into one "no rating" state.
    expect(ratingPanelFetcherPage.getRating()).toHaveTextContent('1268')
    expect(ratingPanelFetcherPage.getRating()).not.toHaveTextContent('Unrated')
    expect(ratingPanelFetcherPage.queryDelta()).not.toBeInTheDocument()
  })

  it('propagates a failed bundle to the ancestor error boundary', async () => {
    ratingPanelFetcherPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    )

    ratingPanelFetcherPage.render()

    await waitForElementToBeRemoved(ratingPanelFetcherPage.queryLoading())
    expect(ratingPanelFetcherPage.queryError()).toBeInTheDocument()
  })
})
