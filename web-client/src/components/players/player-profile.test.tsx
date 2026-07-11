import { HttpResponse, delay } from 'msw'

import {
  buildPlayerCareer,
  buildPlayerDetail,
} from '@/mocks/factories/players/player-detail.factory'
import {
  buildLiveMatchRow,
  buildPlayerMatchList,
  buildPlayerMatchRow,
} from '@/mocks/factories/players/player-match-row.factory'
import { waitForElementToBeRemoved } from '@/test/utilities'

import { playerProfilePage } from './player-profile.page'

describe('PlayerProfile', () => {
  it('paints hero, standing, career AND recent matches from ONE profile request', async () => {
    // The projection pattern's whole promise: every card is a `select` over the
    // same cache entry. If a card's key ever forks from the bundle's, this
    // counter goes to 2 and the page silently doubles its network cost.
    let bundleRequests = 0
    // …and the paginated history endpoint must never be touched at all: the
    // Recent-matches card reads the rows the bundle already carries. Watching it
    // is the only way to prove that — MSW's global handler would happily answer
    // the request if the card regressed to making one.
    let historyRequests = 0
    playerProfilePage.spyOnMatchHistoryEndpoint(() => {
      historyRequests += 1
    })
    playerProfilePage.mockEndpoint(() => {
      bundleRequests += 1
      return HttpResponse.json(
        buildPlayerDetail({
          username: 'rita.kovac',
          rating: 1687,
          rank: 3,
          rank_of: 42,
          peak: 1712,
          member_since: '2024-03-14T09:00:00Z',
          form: 'WWLWLLWWLW',
          wins: 24,
          losses: 11,
          match_total: 50,
          career: buildPlayerCareer({
            decided: 35,
            wins: 24,
            losses: 11,
            win_rate: 24 / 35,
            league_count: 2,
          }),
          matches: buildPlayerMatchList([
            buildPlayerMatchRow({
              opponent: { id: 'p-9', username: 'ada.lovelace' },
            }),
            buildLiveMatchRow({
              opponent: { id: 'p-8', username: 'kai.zhou' },
            }),
          ]),
        }),
      )
    })

    playerProfilePage.render()

    await playerProfilePage.findCard()

    // Identity, from one select…
    expect(playerProfilePage.getName('rita.kovac')).toBeInTheDocument()
    expect(playerProfilePage.queryMemberSince()).toHaveTextContent(
      'Member since Mar 2024',
    )
    // …standing, from another…
    expect(playerProfilePage.getRating()).toHaveTextContent('1687')
    expect(playerProfilePage.queryStat('Rank')).toHaveTextContent('#3 of 42')
    expect(playerProfilePage.queryStat('Peak')).toHaveTextContent('1712')
    expect(playerProfilePage.getChips()).toHaveLength(10)
    // …the cross-league career, from a third — 35 *decided* matches…
    expect(playerProfilePage.getCareerRecord()).toHaveTextContent('24 W · 11 L')
    expect(playerProfilePage.getRingFigure()).toHaveTextContent('68.6%')
    expect(playerProfilePage.getCareerTotal()).toHaveTextContent(
      '35 decided · 2 leagues',
    )
    // …and the six recent matches, from a fourth — the rows the bundle carried,
    // the live one included, under a link that names the all-inclusive total
    // (50), not the 35 decided ones.
    expect(playerProfilePage.getRows()).toHaveLength(2)
    expect(playerProfilePage.getStatusDot('kai.zhou')).toHaveAccessibleName(
      'Live',
    )
    expect(playerProfilePage.getViewAllLink()).toHaveAccessibleName(
      'View all 50 matches',
    )
    // The two totals sit on the same screen and DIFFER — 35 decided beside 50 in
    // the history, because 15 matches are still in play. A page that made them
    // agree would have reintroduced the bug ADR-0915 warns about.
    expect(playerProfilePage.getCareerTotal()).not.toHaveTextContent('50')
    // …off exactly one fetch, and never a call to the paginated history.
    expect(bundleRequests).toBe(1)
    expect(historyRequests).toBe(0)
  })

  it('holds a skeleton per card while the bundle loads', async () => {
    playerProfilePage.mockEndpoint(async () => {
      await delay(20)
      return HttpResponse.json(buildPlayerDetail())
    })

    playerProfilePage.render()

    await playerProfilePage.findHeroLoading()
    expect(playerProfilePage.queryStandingLoading()).toBeInTheDocument()
    expect(playerProfilePage.queryCareerLoading()).toBeInTheDocument()
    expect(playerProfilePage.queryMatchesLoading()).toBeInTheDocument()

    await waitForElementToBeRemoved(playerProfilePage.queryHeroLoading())
    expect(playerProfilePage.queryStandingLoading()).not.toBeInTheDocument()
    expect(playerProfilePage.queryCareerLoading()).not.toBeInTheDocument()
    expect(playerProfilePage.queryMatchesLoading()).not.toBeInTheDocument()
  })

  it('sends a failed bundle to the route’s error boundary — no card catches it', async () => {
    playerProfilePage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    )

    playerProfilePage.render()

    expect(await playerProfilePage.findError()).toBeInTheDocument()
  })
})
