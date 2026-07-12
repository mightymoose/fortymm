import { HttpResponse, delay } from 'msw'

import {
  buildPlayerDetail,
  USATT_LEAGUE_ID,
} from '@/mocks/factories/players/player-detail.factory'
import { waitForElementToBeRemoved } from '@/test/utilities'

import { leaguesCardPage } from './leagues-card.page'

describe('LeaguesCard', () => {
  it('holds its own skeleton while the bundle loads, then paints the card', async () => {
    leaguesCardPage.mockEndpoint(async () => {
      await delay(20)
      return HttpResponse.json(buildPlayerDetail())
    })

    leaguesCardPage.render()

    await leaguesCardPage.findLoading()

    await waitForElementToBeRemoved(leaguesCardPage.queryLoading())
    expect(leaguesCardPage.getLeaguesCard()).toBeInTheDocument()
    expect(leaguesCardPage.getLeagueRows()).toHaveLength(2)
    expect(leaguesCardPage.getSelectedLeagueName()).toBe('FortyMM')
  })

  it('binds the card to the league it is handed', async () => {
    leaguesCardPage.mockEndpoint(() => HttpResponse.json(buildPlayerDetail()))

    leaguesCardPage.render({ leagueId: USATT_LEAGUE_ID })

    await leaguesCardPage.findLeaguesCard()

    expect(leaguesCardPage.getSelectedLeagueName()).toBe('USATT')
    expect(leaguesCardPage.getLeagueRating('USATT')).toBe('1642')
  })
})
