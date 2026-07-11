import { HttpResponse, delay } from 'msw'

import {
  buildDefaultLeague,
  buildPlayerDetail,
  buildSecondLeague,
  USATT_LEAGUE_ID,
} from '@/mocks/factories/players/player-detail.factory'
import { waitForElementToBeRemoved } from '@/test/utilities'

import { leaguesCardFetcherPage } from './leagues-card-fetcher.page'

describe('LeaguesCardFetcher', () => {
  it('suspends until the bundle resolves, then paints a row per league', async () => {
    // The rows come from the bundle itself — `leagues` rides on it, so the card
    // makes no request of its own (anything else would be unhandled and MSW would
    // fail the test).
    leaguesCardFetcherPage.mockEndpoint(async () => {
      await delay(20)
      return HttpResponse.json(buildPlayerDetail())
    })

    leaguesCardFetcherPage.render()

    await leaguesCardFetcherPage.findLoading()
    await waitForElementToBeRemoved(leaguesCardFetcherPage.queryLoading())

    expect(leaguesCardFetcherPage.getLeagueRows()).toHaveLength(2)
    expect(leaguesCardFetcherPage.getLeagueRating('FortyMM')).toBe('1687')
    expect(leaguesCardFetcherPage.getLeagueRating('USATT')).toBe('1642')
  })

  it('highlights the league it was asked for — not the default one', async () => {
    // The selection is a fact about the URL, not about the response: the bundle
    // carries the same `leagues` list whichever league was requested. Hand the
    // card a league and it must mark that row.
    leaguesCardFetcherPage.mockEndpoint(() =>
      HttpResponse.json(buildPlayerDetail()),
    )

    leaguesCardFetcherPage.render({ leagueId: USATT_LEAGUE_ID })

    await leaguesCardFetcherPage.findLeaguesCard()

    expect(leaguesCardFetcherPage.getSelectedLeagueName()).toBe('USATT')
  })

  it('highlights the default league when it is handed none', async () => {
    leaguesCardFetcherPage.mockEndpoint(() =>
      HttpResponse.json(buildPlayerDetail()),
    )

    leaguesCardFetcherPage.render({ leagueId: undefined })

    await leaguesCardFetcherPage.findLeaguesCard()

    expect(leaguesCardFetcherPage.getSelectedLeagueName()).toBe('FortyMM')
  })

  it('renders the single-row card every real player sees today', async () => {
    leaguesCardFetcherPage.mockEndpoint(() =>
      HttpResponse.json(buildPlayerDetail({ leagues: [buildDefaultLeague()] })),
    )

    leaguesCardFetcherPage.render()

    await leaguesCardFetcherPage.findLeaguesCard()

    expect(leaguesCardFetcherPage.getLeagueRows()).toHaveLength(1)
    // Still highlighted, still badged — a card, not a stub.
    expect(leaguesCardFetcherPage.getSelectedLeagueName()).toBe('FortyMM')
    expect(leaguesCardFetcherPage.queryDefaultBadge('FortyMM')).toBeInTheDocument()
  })

  it('propagates a failed bundle to the ancestor error boundary', async () => {
    // No per-card boundary by design: every card shares this one query.
    leaguesCardFetcherPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    )

    leaguesCardFetcherPage.render()

    expect(await leaguesCardFetcherPage.findError()).toBeInTheDocument()
    expect(leaguesCardFetcherPage.queryLoading()).not.toBeInTheDocument()
  })

  it('links each row to this profile with that league selected', async () => {
    leaguesCardFetcherPage.mockEndpoint(() =>
      HttpResponse.json(
        buildPlayerDetail({
          leagues: [buildDefaultLeague(), buildSecondLeague()],
        }),
      ),
    )

    leaguesCardFetcherPage.render()

    await leaguesCardFetcherPage.findLeaguesCard()

    expect(leaguesCardFetcherPage.getLeagueHref('USATT')).toBe(
      `/players/p-1?league=${USATT_LEAGUE_ID}`,
    )
    // …and the default league's row keeps the URL clean.
    expect(leaguesCardFetcherPage.getLeagueHref('FortyMM')).toBe('/players/p-1')
  })
})
