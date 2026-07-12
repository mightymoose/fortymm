import { HttpResponse, delay } from 'msw'

import {
  buildPlayerDetail,
  buildRatingConfidence,
  buildUnratedPlayerDetail,
} from '@/mocks/factories/players/player-detail.factory'
import { waitFor, waitForElementToBeRemoved } from '@/test/utilities'

import { confidenceCardPage } from './confidence-card.page'

describe('ConfidenceCard', () => {
  it('holds its own skeleton while the bundle loads, then paints the card', async () => {
    confidenceCardPage.signInAs('p-9')
    confidenceCardPage.mockEndpoint(async () => {
      await delay(20)
      return HttpResponse.json(
        buildPlayerDetail({
          id: 'p-1',
          confidence: buildRatingConfidence({
            level: 'firming_up',
            interval: { low: 1452, high: 1922 },
          }),
        }),
      )
    })

    confidenceCardPage.render()

    await confidenceCardPage.findLoading()

    await waitForElementToBeRemoved(confidenceCardPage.queryLoading())
    expect(confidenceCardPage.getConfidenceCard()).toBeInTheDocument()
    expect(confidenceCardPage.getConfidenceLevel()).toHaveTextContent('Firming up')
    expect(confidenceCardPage.getConfidenceInterval()).toHaveTextContent(
      'between 1452 and 1922',
    )
  })

  it('resolves its skeleton into NOTHING for an unrated player', async () => {
    // The one card on the profile that can decide it does not exist. Mount it
    // unconditionally anyway — it answers the question itself.
    confidenceCardPage.signInAs('p-9')
    confidenceCardPage.mockEndpoint(async () => {
      await delay(20)
      return HttpResponse.json(buildUnratedPlayerDetail({ id: 'p-1' }))
    })

    confidenceCardPage.render()

    await confidenceCardPage.findLoading()
    await waitForElementToBeRemoved(confidenceCardPage.queryLoading())

    await waitFor(() =>
      expect(confidenceCardPage.queryConfidenceCard()).not.toBeInTheDocument(),
    )
    expect(confidenceCardPage.queryError()).not.toBeInTheDocument()
  })
})
