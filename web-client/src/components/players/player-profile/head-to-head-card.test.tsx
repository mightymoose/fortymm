import { HttpResponse, delay } from 'msw'

import {
  buildNeverMetHeadToHead,
  buildPlayerDetail,
  buildPlayerHeadToHead,
} from '@/mocks/factories/players/player-detail.factory'
import { waitForElementToBeRemoved } from '@/test/utilities'

import { headToHeadCardPage } from './head-to-head-card.page'

describe('HeadToHeadCard', () => {
  it('holds its own skeleton while the bundle loads, then paints the card', async () => {
    headToHeadCardPage.mockEndpoint(async () => {
      await delay(20)
      return HttpResponse.json(buildPlayerDetail({ id: 'p-1' }))
    })

    headToHeadCardPage.render()

    await headToHeadCardPage.findLoading()

    await waitForElementToBeRemoved(headToHeadCardPage.queryLoading())
    expect(headToHeadCardPage.getHeadToHeadCard()).toBeInTheDocument()
    expect(headToHeadCardPage.queryVersusRecord()).toHaveTextContent('1–4')
  })

  it('resolves its skeleton into the invitation when you have never met', async () => {
    // The state a brand-new visitor lands in — the card exists precisely to say
    // so, and to offer the match that would end it.
    headToHeadCardPage.mockEndpoint(async () => {
      await delay(20)
      return HttpResponse.json(
        buildPlayerDetail({
          id: 'p-1',
          username: 'rita.kovac',
          head_to_head: buildPlayerHeadToHead({
            versus_viewer: buildNeverMetHeadToHead(),
          }),
        }),
      )
    })

    headToHeadCardPage.render()

    await headToHeadCardPage.findLoading()
    await waitForElementToBeRemoved(headToHeadCardPage.queryLoading())

    expect(headToHeadCardPage.queryInvite()).toHaveTextContent(
      'You haven’t played rita.kovac yet.',
    )
    expect(headToHeadCardPage.getStartMatchHref()).toBe(
      '/matches/new?opponent=p-1',
    )
    expect(headToHeadCardPage.queryError()).not.toBeInTheDocument()
  })
})
