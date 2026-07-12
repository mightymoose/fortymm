import { HttpResponse, delay } from 'msw'

import {
  buildEmptyCareer,
  buildPlayerCareer,
  buildPlayerDetail,
} from '@/mocks/factories/players/player-detail.factory'
import { waitForElementToBeRemoved } from '@/test/utilities'

import { careerCardFetcherPage } from './career-card-fetcher.page'

describe('CareerCardFetcher', () => {
  it('suspends until the bundle resolves, then paints the career it carries', async () => {
    // The numbers come from the bundle itself — the career block rides on it, so
    // the card makes no request of its own (anything else would be unhandled and
    // MSW would fail the test).
    careerCardFetcherPage.mockEndpoint(async () => {
      await delay(20)
      return HttpResponse.json(
        buildPlayerDetail({
          match_total: 50,
          career: buildPlayerCareer({
            decided: 47,
            wins: 31,
            losses: 16,
            win_rate: 31 / 47,
            games_won_pct: 0.582,
            league_count: 2,
          }),
        }),
      )
    })

    careerCardFetcherPage.render()

    await careerCardFetcherPage.findLoading()
    await waitForElementToBeRemoved(careerCardFetcherPage.queryLoading())

    expect(careerCardFetcherPage.getRingFigure()).toHaveTextContent('66%')
    expect(careerCardFetcherPage.getCareerRecord()).toHaveTextContent(
      '31 W · 16 L',
    )
    expect(careerCardFetcherPage.getCareerStreak()).toHaveTextContent(
      'On a 2-win streak',
    )
    expect(careerCardFetcherPage.queryCareerTile('Best streak')).toHaveTextContent(
      '7 wins',
    )
    expect(careerCardFetcherPage.queryCareerTile('Games won')).toHaveTextContent(
      '58.2%',
    )
    // The total counts the DECIDED matches (47) — not the 50 the history holds.
    expect(careerCardFetcherPage.getCareerTotal()).toHaveTextContent(
      '47 decided · 2 leagues',
    )
    expect(careerCardFetcherPage.getCareerTotal()).not.toHaveTextContent('50')
  })

  it('paints em dashes, not zeroes, for a player who has decided nothing', async () => {
    careerCardFetcherPage.mockEndpoint(() =>
      HttpResponse.json(buildPlayerDetail({ career: buildEmptyCareer() })),
    )

    careerCardFetcherPage.render()

    await waitForElementToBeRemoved(careerCardFetcherPage.queryLoading())

    expect(careerCardFetcherPage.getRingFigure()).toHaveTextContent('—')
    expect(careerCardFetcherPage.getRingFigure()).not.toHaveTextContent('0%')
    expect(careerCardFetcherPage.getCareerStreak()).toHaveTextContent(
      'No current streak',
    )
  })

  it('propagates a failed bundle to the ancestor error boundary', async () => {
    // No per-card boundary by design: every card shares this one query.
    careerCardFetcherPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    )

    careerCardFetcherPage.render()

    expect(await careerCardFetcherPage.findError()).toBeInTheDocument()
    expect(careerCardFetcherPage.queryLoading()).not.toBeInTheDocument()
  })
})
