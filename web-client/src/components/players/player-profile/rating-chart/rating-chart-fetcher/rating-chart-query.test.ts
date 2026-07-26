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
    expect(view.summary).toBe('Up 127 over the last 90 days')
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

  it('says DOWN for a losing window — and never "Down -43", which reads as a rise', () => {
    // The word carries the sign; the number carries the magnitude. Spelling both
    // out gave the sentence — which is also the chart's `aria-label`, i.e. the
    // picture's alt text — a double negative. The CHIP beside it keeps its signed
    // "-43": there the sign is the only thing saying which way the rating went.
    const view = selectRatingChart(buildFallingRatingWindow(), '90d', NOW)

    expect(view.change).toEqual({
      label: '-43',
      aria: 'Lost 43 rating',
      tone: 'down',
    })
    expect(view.summary).toBe('Down 43 over the last 90 days')
    expect(view.summary).not.toContain('-')
  })

  it('says UP with the same bare magnitude — the two sentences are symmetrical', () => {
    const view = selectRatingChart(buildRatingHistoryWindow(), '90d', NOW)

    expect(view.summary).toBe('Up 127 over the last 90 days')
    expect(view.change?.label).toBe('+127') // …while the chip stays signed.
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

  it('dates the 1y window’s left edge WITH ITS YEAR — "Jul 11" a year ago is not today', () => {
    // The 1y window opens a year ago *to the day*, so a bare "Jul 11 … Today" put a
    // label on the axis that is indistinguishable from today's own date. The shorter
    // windows are unambiguous within the current year and stay bare.
    const oneYear = selectRatingChart(buildRatingHistoryWindow(), '1y', NOW)
    const ninetyDays = selectRatingChart(buildRatingHistoryWindow(), '90d', NOW)

    expect(oneYear.xTicks[0].label).toContain('2025')
    expect(oneYear.xTicks[1].label).toBe('Today')
    expect(ninetyDays.xTicks[0].label).not.toMatch(/\d{4}/)
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

  it('marks the peak of the LINE — never a dot sitting BELOW the line it marks', () => {
    // The bug this pins. `window.peak` is the highest point *in the window*, and the
    // ANCHOR is not in the window — but it is DRAWN, and it sets the y-domain. So a
    // player who came in at 1730 and fell to 1687 had their line start at the very top
    // of the plot while the marker labelled 1712 — the highest *in-window* point — as
    // the "peak", planting the dot a third of the way down a line that never goes that
    // high again. The picture contradicted its own marker, and every player whose
    // rating fell across the whole window saw it.
    const view = selectRatingChart(buildFallingRatingWindow(), '90d', NOW)

    const peak = view.peak
    // The apex of the drawn line (y grows downward, so the highest point is the min).
    const apex = Math.min(...ys(view.line))
    expect(peak!.y).toBeLessThanOrEqual(apex)
    // …which here is the anchor: a rating the player really held, at the edge the line
    // really starts from. Marking it is what makes the dot and the line agree.
    expect(peak!.rating).toBe('1730')
    expect(peak!.x).toBe(42) // PLOT.left — the anchor's own vertex, not a floating dot
  })

  it('marks the MATCH that reached the peak, not the synthetic flat run to today', () => {
    // The line's last vertex is a duplicate of the last real rating, held level to
    // today (a rating does not decay while you rest). When that rating IS the window's
    // high, the dot belongs on the match that earned it — sliding it to the right-hand
    // edge would date the peak to a day the player didn't play.
    const view = selectRatingChart(
      buildRatingHistoryWindow({
        anchor: buildRatingPoint({ at: at(100), rating: 1560 }),
        points: [
          buildRatingPoint({ at: at(60), rating: 1600 }),
          buildRatingPoint({ at: at(20), rating: 1700 }),
        ],
        peak: buildRatingPoint({ at: at(20), rating: 1700 }),
        change: 140,
      }),
      '90d',
      NOW,
    )

    const xCoords = xs(view.line)
    expect(view.peak!.x).toBe(xCoords.at(-2)) // the match, twenty days ago…
    expect(view.peak!.x).toBeLessThan(xCoords.at(-1)!) // …and not today's edge.
  })

  it('flips the peak’s LABEL below its dot when the peak sits at the top of the plot', () => {
    // The peak of a window is usually the top of that window's y-domain, which
    // puts its dot at `PLOT.top` (y = 12) — and a 9-unit label 8 units above a dot
    // at 12 has nowhere to go. The old geometry clamped the baseline to 10 and
    // drew the digits straight through a dot spanning 8.5–15.5.
    const view = selectRatingChart(
      buildRatingHistoryWindow({
        anchor: buildRatingPoint({ at: at(100), rating: 1560 }),
        points: [
          buildRatingPoint({ at: at(60), rating: 1600 }),
          // The highest rating in the window, so it lands on the domain's ceiling.
          buildRatingPoint({ at: at(30), rating: 1700 }),
          buildRatingPoint({ at: at(5), rating: 1650 }),
        ],
        peak: buildRatingPoint({ at: at(30), rating: 1700 }),
      }),
      '90d',
      NOW,
    )

    const peak = view.peak
    expect(peak?.y).toBe(12) // PLOT.top — the ceiling
    // Below the dot (bigger y is further down), clear of its 3.5 radius…
    expect(peak!.labelY).toBeGreaterThan(peak!.y + 3.5)
    // …and emphatically not the old clamped baseline that collided with it.
    expect(peak!.labelY).not.toBe(10)
  })

  it('keeps the peak’s label ABOVE its dot when there is room', () => {
    // Now that the peak is folded over the DRAWN vertices, its dot is the top of the
    // y-domain by construction on any window whose rating moved at all — so the
    // no-room flip above is the common case, and clear air exists only on a FLAT
    // window, whose zero-height domain is padded out around the single rating and
    // leaves the dot mid-plot. (This test used to be driven by an anchor of 1800 over
    // points of 1600/1650 — which is not "room above the peak" at all, it is the bug:
    // a peak dot 1650 sitting below a line that starts at 1800.)
    const view = selectRatingChart(
      buildRatingHistoryWindow({
        anchor: buildRatingPoint({ at: at(100), rating: 1600 }),
        points: [buildRatingPoint({ at: at(30), rating: 1600 })],
        peak: buildRatingPoint({ at: at(30), rating: 1600 }),
        change: 0,
      }),
      '90d',
      NOW,
    )

    const peak = view.peak
    expect(peak!.y).toBeGreaterThan(12) // not on the ceiling: the padding lifts it off
    expect(peak!.labelY).toBe(peak!.y - 8) // dot radius (3.5) + the gap (4.5)
    expect(peak!.labelY).toBeLessThan(peak!.y) // above (y grows downward)
    // …and, sitting mid-plot, it is centred on its dot: both halves fit.
    expect(peak!.labelAnchor).toBe('middle')
  })

  it('keeps the peak’s label INSIDE the plot when the peak is the LATEST point', () => {
    // The player whose most recent match IS their high-water mark: the dot lands on
    // the plot's right edge (x = 590 of a 600-wide viewBox), and a label *centred*
    // there hangs half a four-digit rating off the end of the SVG and through the
    // "Today" axis label. Anchored at its end, the text grows left off the dot and
    // stays inside.
    const view = selectRatingChart(
      buildRatingHistoryWindow({
        anchor: buildRatingPoint({ at: at(100), rating: 1600 }),
        points: [
          buildRatingPoint({ at: at(40), rating: 1620 }),
          buildRatingPoint({ at: at(0), rating: 1700 }),
        ],
        peak: buildRatingPoint({ at: at(0), rating: 1700 }),
        change: 100,
      }),
      '90d',
      NOW,
    )

    const peak = view.peak
    expect(peak!.x).toBe(590) // CHART_WIDTH - PLOT.right — hard against the edge
    expect(peak!.labelAnchor).toBe('end')
    // The vertical placement is untouched by the horizontal fix: this peak is the
    // top of the y-domain, so its label still flips BELOW the dot rather than
    // running off the top of the viewBox.
    expect(peak!.y).toBe(12)
    expect(peak!.labelY).toBeGreaterThan(peak!.y + 3.5)
  })

  it('keeps the peak’s label INSIDE the plot when the peak is the ANCHOR, on the left edge', () => {
    // The mirror image, and the one the falling window already produces: the peak is
    // the anchor, drawn at x = PLOT.left. Centred, the label would spill left into
    // the y-axis gutter and its digits over the rating labels; anchored at its start
    // it grows right, into the plot.
    const view = selectRatingChart(buildFallingRatingWindow(), '90d', NOW)

    expect(view.peak!.x).toBe(42) // PLOT.left
    expect(view.peak!.labelAnchor).toBe('start')
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

  it('zooms the x-domain to fit a history collapsed into one evening (#957)', () => {
    // A brand-new player's whole history is one session. On the raw 90-day calendar
    // axis every point shares almost the same x and the line collapses to a ~1px
    // spike hard against the right edge (`M589.48 … L589.5`). With no anchor pinning
    // it to the left, the domain zooms to the data so the session fans across the
    // plot instead.
    const view = selectRatingChart(
      buildRatingHistoryWindow({
        anchor: null,
        points: [
          buildRatingPoint({ at: at(0.8), rating: 1500 }),
          buildRatingPoint({ at: at(0.4), rating: 1516 }),
          buildRatingPoint({ at: at(0.05), rating: 1524 }),
        ],
        peak: buildRatingPoint({ at: at(0.05), rating: 1524 }),
        change: 24,
      }),
      '90d',
      NOW,
    )

    const xCoords = xs(view.line)
    // The earliest match is pinned to the plot's left edge — the domain was zoomed
    // to the data span, NOT left at window-start (where a 0.8-day-old point would
    // sit at x ≈ 585, jammed against the others in a sub-pixel cluster).
    expect(xCoords[0]).toBe(42) // PLOT.left
    // …so the whole session fans across most of the 548-unit plot rather than
    // clustering against the right edge.
    expect(xCoords.at(-1)! - xCoords[0]).toBeGreaterThan(400)
    expect(new Set(xCoords).size).toBeGreaterThan(2)
    // It is a real line, not the degenerate single-instant fallback.
    expect(view.singleInstant).toBeNull()
  })

  it('draws a LINE for a freshly-rated player: seed rating + first match, seconds apart, no anchor (#957)', () => {
    // The regression the composed root-e2e caught (`seedRatedPlayer`). A brand-new
    // rated player's whole history is TWO points seconds apart — the `initial` seed
    // rating and their first match — with no carry-in anchor, on the 90d range. The
    // old zoom floored the domain to a fixed [now − 3h, now] window, which clustered
    // these two *recent* points against the right edge; the drawn extent fell below
    // a viewBox unit and the projection reported "2 matches today" INSTEAD of the
    // line (5 e2e specs asserting the line went red). Distinct timestamps must fan
    // into a real line: `singleInstant` is null and the session spans the plot.
    const sec = 1 / (24 * 60 * 60)
    const view = selectRatingChart(
      buildRatingHistoryWindow({
        anchor: null,
        points: [
          buildRatingPoint({ at: at(15 * sec), rating: 1500 }), // the seed rating
          buildRatingPoint({ at: at(5 * sec), rating: 1516 }), // the first match, 10s later
        ],
        peak: buildRatingPoint({ at: at(5 * sec), rating: 1516 }),
        change: 16,
      }),
      '90d',
      NOW,
    )

    // A real, drawn line — not the degenerate single-instant label.
    expect(view.singleInstant).toBeNull()
    expect(view.line).not.toBe('')
    const xCoords = xs(view.line)
    // The earliest (seed) point is pinned to the left edge — the domain fit the
    // data span rather than flooring recent points against the right edge…
    expect(xCoords[0]).toBe(42) // PLOT.left
    // …so the two-point session fans across most of the plot.
    expect(xCoords.at(-1)! - xCoords[0]).toBeGreaterThan(400)
    expect(new Set(xCoords).size).toBeGreaterThan(1)
  })

  it('does NOT zoom when a carry-in anchor holds the line to the left edge (#957)', () => {
    // The zoom is only for a line with nothing pinning it left. An anchored line
    // already spans the plot — the anchor is drawn at window-start (ADR-0915), and
    // re-homing it onto a zoomed domain would misdate a point whose whole meaning
    // is "as of the window start". So the same one-evening points, given an anchor,
    // stay on the full calendar domain: the anchor at the far left, the matches
    // clustered at the right, exactly as ADR-0915 draws them.
    const view = selectRatingChart(
      buildRatingHistoryWindow({
        anchor: buildRatingPoint({ at: at(120), rating: 1490 }),
        points: [
          buildRatingPoint({ at: at(0.8), rating: 1500 }),
          buildRatingPoint({ at: at(0.05), rating: 1524 }),
        ],
        peak: buildRatingPoint({ at: at(0.05), rating: 1524 }),
        change: 34,
      }),
      '90d',
      NOW,
    )

    const xCoords = xs(view.line)
    expect(xCoords[0]).toBe(42) // the anchor, drawn at window-start
    // The in-window matches sit hard against the right edge — the full-window
    // behaviour the anchor preserves, and the spike the no-anchor case above avoids.
    expect(xCoords[1]).toBeGreaterThan(580)
    expect(view.singleInstant).toBeNull()
  })

  it('degrades to an "N matches today" state when every match is at one instant (#957)', () => {
    // The one case the zoom cannot rescue: genuinely identical timestamps. The
    // minimum-span floor fans nothing when there is nothing to fan, so rather than
    // draw a sub-pixel spike the projection reports the real count for the card to
    // state in words.
    const instant = at(0)
    const view = selectRatingChart(
      buildRatingHistoryWindow({
        anchor: null,
        points: [
          buildRatingPoint({ at: instant, rating: 1500 }),
          buildRatingPoint({ at: instant, rating: 1512 }),
          buildRatingPoint({ at: instant, rating: 1525 }),
        ],
        peak: buildRatingPoint({ at: instant, rating: 1525 }),
        change: 25,
      }),
      '90d',
      NOW,
    )

    expect(view.singleInstant).toEqual({ matchCount: 3 })
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
