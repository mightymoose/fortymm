import { HttpResponse } from 'msw'

import {
  playerQueryKey,
  ratingHistoryQueryKey,
  ratingHistoryQueryOptions,
} from '@/api/players'
import {
  buildEmptyRatingWindow,
  buildFallingRatingWindow,
  buildRatingHistoryWindow,
  buildRatingPoint,
  buildUnratedRatingWindow,
} from '@/mocks/factories/players/rating-history.factory'
import { waitFor } from '@/test/utilities'

import { selectRatingChart } from './rating-chart-query'
import { ratingChartQueryPage } from './rating-chart-query.page'

/** A fixed "now", so the geometry below is arithmetic and not a clock race. */
const NOW = Date.parse('2026-07-11T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const at = (days: number) => new Date(NOW - days * DAY).toISOString()

/** The x of the nth vertex of the drawn line. */
const xs = (path: string): number[] =>
  [...path.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => Number(m[1]))
const ys = (path: string): number[] =>
  [...path.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => Number(m[2]))

describe('selectRatingChart', () => {
  it('starts the line at the ANCHOR — the rating carried in from before the window', () => {
    // The whole reason the endpoint returns a point from outside the window
    // (ADR-0915). This player's first match *in* the window was at 1602; they came
    // into it at 1560. A chart that clipped strictly to the window would start the
    // line at 1602 and quietly under-report the ninety-day story by 42 points.
    const view = selectRatingChart(
      buildRatingHistoryWindow({
        anchor: buildRatingPoint({ at: at(100), rating: 1560 }),
        points: [
          buildRatingPoint({ at: at(72), rating: 1602 }),
          buildRatingPoint({ at: at(9), rating: 1687 }),
        ],
        change: 127,
      }),
      '90d',
      NOW,
    )

    // Four vertices: the anchor, the two matches, and the flat run to today.
    const yCoords = ys(view.line)
    expect(yCoords).toHaveLength(4)
    // The anchor is the LOWEST rating (1560), so it is the *bottom* of the plot —
    // and it is drawn at the window's left edge, x = the plot's origin.
    expect(xs(view.line)[0]).toBe(42)
    expect(yCoords[0]).toBeGreaterThan(yCoords[1]) // 1560 sits below 1602 (y grows downward)
    expect(view.summary).toBe('Up +127 over the last 90 days')
  })

  it('runs FLAT to today at the current rating — a rating does not decay while you rest', () => {
    // The last rated match was three weeks ago. The rating today is still the
    // rating: the line's last two vertices share a y, and the last one sits at the
    // right-hand edge.
    const view = selectRatingChart(
      buildRatingHistoryWindow({
        points: [
          buildRatingPoint({ at: at(60), rating: 1600 }),
          buildRatingPoint({ at: at(21), rating: 1687 }),
        ],
      }),
      '90d',
      NOW,
    )

    const yCoords = ys(view.line)
    const xCoords = xs(view.line)
    expect(yCoords.at(-1)).toBe(yCoords.at(-2))
    expect(xCoords.at(-1)).toBeGreaterThan(xCoords.at(-2)!)
    expect(view.current.rating).toBe('1687')
  })

  it('draws an empty window FLAT at the current rating, and suppresses the change entirely', () => {
    // A rated player who hasn't played in ninety days. Not an error, not an empty
    // box: a flat line at the rating they still hold, and NO chip — "+0" would
    // claim they played and moved nothing.
    const view = selectRatingChart(buildEmptyRatingWindow(), '90d', NOW)

    const yCoords = ys(view.line)
    expect(yCoords).toHaveLength(2)
    expect(new Set(yCoords).size).toBe(1) // flat
    expect(view.change).toBeNull()
    expect(view.peak).toBeNull()
    expect(view.isEmptyWindow).toBe(true)
    expect(view.summary).toBe('No rated matches in the last 90 days')
    expect(JSON.stringify(view)).not.toContain('+0')
  })

  it('never renders “+0” for a window that netted exactly zero either', () => {
    // The other way to reach a zero: they played, and came back to where they
    // started. The chip is about *movement*, and there was none — say it in words.
    const view = selectRatingChart(
      buildRatingHistoryWindow({ change: 0 }),
      '90d',
      NOW,
    )

    expect(view.change).toBeNull()
    expect(view.summary).toBe('No change over the last 90 days')
  })

  it('says DOWN, with a signed figure, for a losing window', () => {
    const view = selectRatingChart(buildFallingRatingWindow(), '90d', NOW)

    expect(view.change).toEqual({
      label: '-43',
      aria: 'Lost 43 rating',
      tone: 'down',
    })
    expect(view.summary).toBe('Down -43 over the last 90 days')
  })

  it('names the window it was asked for — 30 days, 90 days, a year', () => {
    const window = buildEmptyRatingWindow()

    expect(selectRatingChart(window, '30d', NOW).summary).toBe(
      'No rated matches in the last 30 days',
    )
    expect(selectRatingChart(window, '1y', NOW).summary).toBe(
      'No rated matches in the last year',
    )
  })

  it('marks the window’s peak — which is NOT the profile’s all-time peak', () => {
    // Two different numbers sit on the same page: the hero's peak (1712, all-time
    // on this ladder) and the chart's (the highest point *in this window*). Reading
    // either for the other is the mistake this pins.
    const view = selectRatingChart(
      buildRatingHistoryWindow({
        peak: buildRatingPoint({ at: at(31), rating: 1701 }),
      }),
      '90d',
      NOW,
    )

    expect(view.peak?.rating).toBe('1701')
    expect(view.peak?.x).toBeGreaterThan(42)
  })

  it('survives a player with no rating at all — no NaNs on the axes', () => {
    // The profile never asks for this (an unrated player gets no chart), but a
    // divide-by-zero on an empty domain would paint every coordinate as `NaN` and
    // fail silently — an SVG with a `d="MNaN NaN"` renders as nothing at all.
    const view = selectRatingChart(buildUnratedRatingWindow(), '90d', NOW)

    expect(view.line).toBe('')
    expect(view.area).toBe('')
    expect(view.change).toBeNull()
    expect(JSON.stringify(view)).not.toContain('NaN')
  })

  it('stretches the domain to fit a line older than the window — the previous range, held on screen', () => {
    // While a 90d → 30d flip is in flight the card keeps the previous line up
    // (`keepPreviousData`), so the projection is asked to draw 90 days of points
    // inside a 30-day window. It must widen the domain rather than pile two thirds
    // of the line up on the left edge.
    const ninetyDays = buildRatingHistoryWindow({
      anchor: buildRatingPoint({ at: at(100), rating: 1560 }),
      points: [
        buildRatingPoint({ at: at(72), rating: 1602 }),
        buildRatingPoint({ at: at(9), rating: 1687 }),
      ],
    })

    const drawnIn30d = selectRatingChart(ninetyDays, '30d', NOW)
    const xCoords = xs(drawnIn30d.line)

    // The line runs left to right and never doubles back — which it would if the
    // anchor were pinned to `now - 30d` while the points it precedes are older
    // than that, drawing a zigzag through its own history.
    expect(xCoords).toEqual([...xCoords].sort((a, b) => a - b))
    // …and it spans the plot rather than piling up on the left edge: the 72-day-old
    // point is not squashed against the 9-day-old one.
    expect(xCoords.at(-1)! - xCoords[0]).toBeGreaterThan(400)
    expect(new Set(xCoords).size).toBeGreaterThan(2)
  })
})

describe('the chart’s own query', () => {
  it('is keyed on the RANGE — that is what makes a flip fetch only the range', () => {
    // If range fell out of the key, flipping a tab would read the previous
    // window's cache entry and never fetch. If the *bundle's* key gained it, a flip
    // would refetch the whole page.
    expect(ratingHistoryQueryOptions('p-1', { range: '30d' }).queryKey).toEqual(
      ratingHistoryQueryKey('p-1', undefined, '30d'),
    )
    expect(
      ratingHistoryQueryOptions('p-1', { range: '30d' }).queryKey,
    ).not.toEqual(ratingHistoryQueryOptions('p-1', { range: '1y' }).queryKey)
    // …and it is not the bundle's key: the chart does not project off the bundle.
    expect(ratingHistoryQueryOptions('p-1', {}).queryKey).not.toEqual(
      playerQueryKey('p-1'),
    )
  })

  it('treats “no range” and the default range as ONE cache entry', () => {
    // A URL with no `?range=` *means* 90d. Two entries for one window would mean
    // the seeded one gets missed and the chart fetches what it was already handed.
    expect(ratingHistoryQueryKey('p-1', undefined, undefined)).toEqual(
      ratingHistoryQueryKey('p-1', undefined, '90d'),
    )
  })

  it('fetches exactly the range and league it was asked for', async () => {
    const asked: string[] = []
    ratingChartQueryPage.mockEndpoint(({ request }) => {
      const url = new URL(request.url)
      asked.push(`${url.searchParams.get('range')}`)
      return HttpResponse.json(buildRatingHistoryWindow())
    })

    const { result } = ratingChartQueryPage.render({ range: '1y' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(asked).toEqual(['1y'])
  })

  it('does NOT throw a failure at a boundary — it hands it back to the card', async () => {
    // The whole reason this card cannot use `useSuspenseQuery`. A failed range must
    // be catchable *inside* the card; `throwOnError` would send it to the route's
    // error boundary and blank the profile.
    ratingChartQueryPage.mockEndpoint(
      () => new HttpResponse(null, { status: 500 }),
    )

    const { result } = ratingChartQueryPage.render({ range: '30d' })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeTruthy()
  })

  it('keeps a seeded window FRESH — or the seed would be refetched on sight', async () => {
    // `staleTime` is on the options, not left to the app's QueryClient default. With
    // a `staleTime` of 0 the data seeded out of the profile bundle would be stale
    // the instant it landed, `refetchOnMount` would fire, and the chart's "first
    // paint costs no request" promise would be quietly false — in tests especially,
    // whose client sets no default.
    expect(ratingHistoryQueryOptions('p-1', {}).staleTime).toBeGreaterThan(0)
  })
})
