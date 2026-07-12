import { HttpResponse, delay } from 'msw'

import {
  buildPlayerCareer,
  buildPlayerDetail,
} from '@/mocks/factories/players/player-detail.factory'
import { waitForElementToBeRemoved } from '@/test/utilities'

import { careerCardPage } from './career-card.page'

describe('CareerCard', () => {
  it('holds its own skeleton while the bundle loads, then paints the card', async () => {
    careerCardPage.mockEndpoint(async () => {
      await delay(20)
      return HttpResponse.json(
        buildPlayerDetail({
          career: buildPlayerCareer({
            decided: 47,
            wins: 31,
            losses: 16,
            win_rate: 31 / 47,
            league_count: 2,
          }),
        }),
      )
    })

    careerCardPage.render()

    await careerCardPage.findLoading()

    await waitForElementToBeRemoved(careerCardPage.queryLoading())
    expect(careerCardPage.getCareerCard()).toBeInTheDocument()
    expect(careerCardPage.getCareerRecord()).toHaveTextContent('31 W · 16 L')
    expect(careerCardPage.getCareerTotal()).toHaveTextContent(
      '47 decided · 2 leagues',
    )
  })
})
