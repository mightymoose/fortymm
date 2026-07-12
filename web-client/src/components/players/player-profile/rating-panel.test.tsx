import { HttpResponse } from 'msw'

import { buildPlayerDetail } from '@/mocks/factories/players/player-detail.factory'
import { waitForElementToBeRemoved } from '@/test/utilities'

import { ratingPanelPage } from './rating-panel.page'

describe('RatingPanel', () => {
  it('holds its own skeleton while the bundle loads, then paints the standing', async () => {
    ratingPanelPage.mockEndpoint(() =>
      HttpResponse.json(buildPlayerDetail({ rating: 1687 })),
    )

    ratingPanelPage.render()

    expect(ratingPanelPage.queryLoading()).toBeInTheDocument()

    await waitForElementToBeRemoved(ratingPanelPage.queryLoading())
    expect(ratingPanelPage.getRating()).toHaveTextContent('1687')
  })
})
