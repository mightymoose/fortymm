import { HttpResponse, delay } from 'msw'

import {
  buildPlayerCareer,
  buildPlayerDetail,
  USATT_LEAGUE_ID,
} from '@/mocks/factories/players/player-detail.factory'
import {
  buildPlayerHeadToHead,
  buildSelfHeadToHead,
} from '@/mocks/factories/players/head-to-head.factory'
import {
  buildLiveMatchRow,
  buildPlayerMatchList,
  buildPlayerMatchRow,
} from '@/mocks/factories/players/player-match-row.factory'
import { waitFor, waitForElementToBeRemoved } from '@/test/utilities'

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

  it('leads with HEAD-TO-HEAD on someone else’s profile — the phone’s first screen', async () => {
    // The page is one column at every width, so this list IS what a phone reads
    // top-to-bottom (and what a keyboard tabs through, and what a screen reader
    // announces). jsdom has no layout engine — a CSS `order:` would be invisible
    // to it — so the order lives in the DOM, and this asserts the DOM.
    //
    // On somebody else's profile the first screen and a half belongs to "am I
    // going to beat this person, and shall we play right now?" (ADR-0915): the
    // viewer's record against them and the Start-a-match CTA, not a 90-day chart.
    playerProfilePage.mockEndpoint(() =>
      HttpResponse.json(
        buildPlayerDetail({ head_to_head: buildPlayerHeadToHead() }),
      ),
    )

    playerProfilePage.render()

    await playerProfilePage.findCard()
    await waitFor(() => expect(playerProfilePage.getCardOrder()).toHaveLength(6))

    expect(playerProfilePage.getCardOrder()).toEqual([
      'Head-to-head',
      'Recent matches',
      'Career',
      'Rating over time',
      'Rating confidence',
      'Leagues',
    ])
  })

  it('leads with CAREER on your own profile — read from the payload, not the session', async () => {
    // Same page, same six cards, a different order — and the bit that decides it
    // comes from the BUNDLE (`versus_viewer: null` ⟺ this is you), never from the
    // session. The session doesn't suspend and the bundle does, so a page ordering
    // itself off the session would render its first frames in a stranger's order
    // and then reshuffle a fully-painted page (ADR-0915).
    //
    // The win-rate ring is what you came for; your frequent opponents sink to the
    // bottom, and there is no record against yourself to lead with.
    playerProfilePage.mockEndpoint(() =>
      HttpResponse.json(
        buildPlayerDetail({ head_to_head: buildSelfHeadToHead() }),
      ),
    )

    playerProfilePage.render()

    await playerProfilePage.findCard()
    await waitFor(() => expect(playerProfilePage.getCardOrder()).toHaveLength(6))

    expect(playerProfilePage.getCardOrder()).toEqual([
      'Career',
      'Rating over time',
      'Recent matches',
      'Rating confidence',
      'Leagues',
      // The head-to-head card in its self form — no "you vs you", just the list.
      'Frequent opponents',
    ])
  })

  it('hands the desktop grid the class hooks it places the two columns by', async () => {
    // The desktop layout is a two-column grid (`player-profile.css`), and it
    // CANNOT be built by reordering the DOM: the DOM order is the phone's, and
    // viewer-dependent (the two tests above). So the grid places each card
    // explicitly, keyed on the card's own root class — which makes those class
    // names a contract between the components and the stylesheet.
    //
    // Be clear about what this does and does not prove. jsdom has no layout
    // engine: it cannot see a column, a row or a gap, and a test that claimed to
    // check the grid here would be checking nothing. What it pins is the *hook* —
    // rename `.career-card` on the card's root and the CSS keeps compiling, the
    // page keeps rendering, and the card quietly drops out of the narrow column
    // into whatever auto-placement does with it. That regression is invisible to
    // every other test in this file. The columns themselves are verified in a
    // browser.
    playerProfilePage.mockEndpoint(() =>
      HttpResponse.json(
        buildPlayerDetail({ head_to_head: buildSelfHeadToHead() }),
      ),
    )

    playerProfilePage.render()

    await playerProfilePage.findCard()
    await waitFor(() =>
      expect(playerProfilePage.getCardPlacementHooks()).toHaveLength(6),
    )

    // In DOM order — which is the phone's order, NOT the desktop columns. The
    // trailing note on each row is the column that card's class is placed into at
    // ≥960px, and the fact that those two sequences disagree is the whole reason
    // the grid is built out of explicit placement rather than out of the DOM.
    expect(playerProfilePage.getCardPlacementHooks()).toEqual([
      ['Career', 'career-card'], // narrow column, row 1
      ['Rating over time', 'rating-chart'], // wide column, row 1
      ['Recent matches', 'recent-matches'], // wide column, rows 2…
      ['Rating confidence', 'confidence-card'], // narrow column, row 2
      ['Leagues', 'leagues-card'], // narrow column, row 3
      ['Frequent opponents', 'head-to-head'], // narrow column, row 4
    ])
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
