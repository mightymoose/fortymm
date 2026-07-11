import { HttpResponse, delay } from 'msw'

import {
  buildPlayerCareer,
  buildPlayerDetail,
  USATT_LEAGUE_ID,
} from '@/mocks/factories/players/player-detail.factory'
import {
  buildLiveMatchRow,
  buildPlayerMatchList,
  buildPlayerMatchRow,
} from '@/mocks/factories/players/player-match-row.factory'
import { waitForElementToBeRemoved } from '@/test/utilities'

import { playerProfilePage } from './player-profile.page'

describe('PlayerProfile', () => {
  it('paints hero, standing, career, confidence AND recent matches from ONE profile request', async () => {
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
    // …the rating's confidence, from a fourth — its level in words and its 95%
    // interval, on the card's face. (Which *person* it speaks in is the card's
    // own suite's business; here the point is that a fifth `select` over the same
    // entry costs nothing.)
    expect(playerProfilePage.getConfidenceLevel()).toHaveTextContent('Settled')
    expect(playerProfilePage.getConfidenceInterval()).toHaveTextContent(
      'somewhere between 1551 and 1823',
    )
    // …and the six recent matches, from a fifth — the rows the bundle carried,
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

  it('STILL costs one bundle request with a LEAGUE SELECTED — every card is keyed on it', async () => {
    // The test above cannot see this, and that is the point of this one.
    //
    // With no `?league=` in the URL, `playerByIdQueryOptions(id)` and
    // `playerByIdQueryOptions(id, undefined)` produce the SAME key — so a card
    // still on the league-less 1-arg form collides harmlessly with the rest and
    // nothing reds. Select a league and the two forms diverge: the pinned cards
    // ask for `?league_id=<usatt>` while the unpinned one asks for the default
    // ladder, and the page quietly issues two bundle requests instead of one.
    //
    // So this counts requests with a league selected, and records WHICH ladder
    // each one asked for — a forked card shows up as a second entry reading
    // `null`, which names the culprit's shape rather than just failing a count.
    const leaguesAsked: (string | null)[] = []
    playerProfilePage.mockEndpoint(({ request }) => {
      leaguesAsked.push(new URL(request.url).searchParams.get('league_id'))
      return HttpResponse.json(
        buildPlayerDetail({
          username: 'rita.kovac',
          match_total: 50,
          career: buildPlayerCareer({ decided: 35, league_count: 2 }),
        }),
      )
    })

    playerProfilePage.render({ leagueId: USATT_LEAGUE_ID })

    await playerProfilePage.findCard()

    // Every one of the six cards painted — a page that dropped a card would
    // otherwise pass a request count trivially, by not asking for anything.
    expect(playerProfilePage.getName('rita.kovac')).toBeInTheDocument() // hero
    expect(playerProfilePage.getRating()).toBeInTheDocument() // rating panel
    expect(playerProfilePage.getCareerRecord()).toBeInTheDocument() // career
    expect(playerProfilePage.getLeagueRows().length).toBeGreaterThan(0) // leagues
    expect(playerProfilePage.getConfidenceLevel()).toBeInTheDocument() // confidence
    expect(playerProfilePage.getHeadToHeadCard()).toBeInTheDocument() // head-to-head
    expect(playerProfilePage.getRows().length).toBeGreaterThan(0) // recent matches

    // …off ONE request, and one that named the league. Two entries here means a
    // card forked its key; a lone `null` means they all did.
    expect(leaguesAsked).toEqual([USATT_LEAGUE_ID])
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
    expect(playerProfilePage.queryConfidenceLoading()).toBeInTheDocument()
    expect(playerProfilePage.queryHeadToHeadLoading()).toBeInTheDocument()
    expect(playerProfilePage.queryMatchesLoading()).toBeInTheDocument()

    await waitForElementToBeRemoved(playerProfilePage.queryHeroLoading())
    expect(playerProfilePage.queryStandingLoading()).not.toBeInTheDocument()
    expect(playerProfilePage.queryCareerLoading()).not.toBeInTheDocument()
    expect(playerProfilePage.queryConfidenceLoading()).not.toBeInTheDocument()
    expect(playerProfilePage.queryHeadToHeadLoading()).not.toBeInTheDocument()
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
