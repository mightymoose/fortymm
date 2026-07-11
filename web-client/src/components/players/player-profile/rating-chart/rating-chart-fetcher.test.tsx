import { HttpResponse, delay } from 'msw'

import {
  buildPlayerDetail,
  buildUnratedPlayerDetail,
} from '@/mocks/factories/players/player-detail.factory'
import {
  buildEmptyRatingWindow,
  buildFallingRatingWindow,
  buildRatingHistoryWindow,
} from '@/mocks/factories/players/rating-history.factory'
import { waitFor, waitForElementToBeRemoved } from '@/test/utilities'

import { ratingChartFetcherPage } from './rating-chart-fetcher.page'

const PROFILE_ID = 'p-1'

describe('RatingChartFetcher', () => {
  it('paints the chart from the BUNDLE — first paint costs NO rating-history request', async () => {
    // The card owns its own query (a range flip must fetch only the range), but its
    // cache is seeded from the `rating_history` block the profile bundle already
    // carries. So the chart is drawn before any request of its own could even have
    // been made.
    //
    // Counting is the only way to say this: the endpoint has a global handler, so a
    // chart that fetched on mount would go green on the DOM and cost a silent extra
    // round trip on every profile view.
    const historyCalls = ratingChartFetcherPage.spyOnRatingHistory()
    ratingChartFetcherPage.mockBundle(() =>
      HttpResponse.json(
        buildPlayerDetail({
          id: PROFILE_ID,
          rating: 1687,
          rating_history: buildRatingHistoryWindow({ change: 127 }),
        }),
      ),
    )

    ratingChartFetcherPage.render({ playerId: PROFILE_ID })

    await ratingChartFetcherPage.findChartCard()
    expect(ratingChartFetcherPage.queryChartLine()).toBeInTheDocument()
    expect(ratingChartFetcherPage.getChartSummary()).toBe(
      'Up +127 over the last 90 days',
    )
    // Give a stray fetch every chance to land before we claim there wasn't one.
    await waitFor(() => expect(historyCalls).toEqual([]))
  })

  it('seeds the window the page ASKED FOR — the bundle carries the URL’s range', async () => {
    // The seed is only honest if the bundle's embedded window is the window the
    // page is showing. The card projects its gate off that same bundle query, so
    // the range goes out on the bundle's *request* — and a bundle fetched for 90d
    // must never be seeded into a 30d chart.
    const historyCalls = ratingChartFetcherPage.spyOnRatingHistory()
    const bundleRanges: (string | null)[] = []
    ratingChartFetcherPage.mockBundle(({ request }) => {
      bundleRanges.push(new URL(request.url).searchParams.get('range'))
      return HttpResponse.json(
        buildPlayerDetail({
          id: PROFILE_ID,
          // What a 30-day window happens to look like for this player: down 43.
          rating_history: buildFallingRatingWindow(),
        }),
      )
    })

    ratingChartFetcherPage.render({ playerId: PROFILE_ID, range: '30d' })

    await ratingChartFetcherPage.findChartCard()
    expect(bundleRanges).toEqual(['30d'])
    expect(ratingChartFetcherPage.getChartSummary()).toBe(
      'Down -43 over the last 30 days',
    )
    await waitFor(() => expect(historyCalls).toEqual([]))
  })

  it('renders NO chart for an unrated player — and asks for no history at all', async () => {
    // No rating, no timeline. The slot says so; and the card must not go and fetch
    // a rating history for a player who has never had one.
    const historyCalls = ratingChartFetcherPage.spyOnRatingHistory()
    ratingChartFetcherPage.mockBundle(async () => {
      await delay(20)
      return HttpResponse.json(buildUnratedPlayerDetail({ id: PROFILE_ID }))
    })

    ratingChartFetcherPage.render({ playerId: PROFILE_ID })

    await ratingChartFetcherPage.findChartSkeleton()
    await waitForElementToBeRemoved(ratingChartFetcherPage.queryChartSkeleton())

    expect(await ratingChartFetcherPage.findUnratedPanel()).toBeInTheDocument()
    expect(ratingChartFetcherPage.queryChartLine()).not.toBeInTheDocument()
    expect(ratingChartFetcherPage.queryChangeChip()).toBeNull()
    await waitFor(() => expect(historyCalls).toEqual([]))
  })

  it('draws a rated player with an EMPTY window flat, with no “+0”', async () => {
    // The first-class empty state (ADR-0915): they have a rating, they just haven't
    // played. A flat line at that rating, a sentence saying why — and no chip.
    ratingChartFetcherPage.spyOnRatingHistory()
    ratingChartFetcherPage.mockBundle(() =>
      HttpResponse.json(
        buildPlayerDetail({
          id: PROFILE_ID,
          rating: 1687,
          rating_history: buildEmptyRatingWindow(),
        }),
      ),
    )

    ratingChartFetcherPage.render({ playerId: PROFILE_ID })

    await ratingChartFetcherPage.findChartCard()
    expect(ratingChartFetcherPage.getChartSummary()).toBe(
      'No rated matches in the last 90 days',
    )
    expect(ratingChartFetcherPage.queryChangeChip()).toBeNull()
    // It still draws — the flat line IS the answer, not an absence of one.
    expect(ratingChartFetcherPage.queryChartLine()).toBeInTheDocument()
  })

  it('holds the bundle’s skeleton, then paints — the gate is a projection, not a second request', async () => {
    let bundleRequests = 0
    ratingChartFetcherPage.spyOnRatingHistory()
    ratingChartFetcherPage.mockBundle(async () => {
      bundleRequests += 1
      await delay(20)
      return HttpResponse.json(buildPlayerDetail({ id: PROFILE_ID }))
    })

    ratingChartFetcherPage.render({ playerId: PROFILE_ID })

    await ratingChartFetcherPage.findChartSkeleton()
    await waitForElementToBeRemoved(ratingChartFetcherPage.queryChartSkeleton())

    expect(ratingChartFetcherPage.queryChartLine()).toBeInTheDocument()
    expect(bundleRequests).toBe(1)
  })

  it('sends a failed BUNDLE to the route — that one really is the whole page', async () => {
    // The gate is a projection off the bundle, so it throws like every other card:
    // if the profile itself couldn't load, there is no page to render this card on.
    // (Contrast with a failed *range*, below.)
    ratingChartFetcherPage.spyOnRatingHistory()
    ratingChartFetcherPage.mockBundle(
      () => new HttpResponse(null, { status: 500 }),
    )

    ratingChartFetcherPage.render({ playerId: PROFILE_ID })

    expect(await ratingChartFetcherPage.findRouteError()).toBeInTheDocument()
    expect(ratingChartFetcherPage.queryChartCard()).not.toBeInTheDocument()
  })
})
