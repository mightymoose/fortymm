import {
  buildChartView,
  buildEmptyChartView,
  buildSingleInstantChartView,
} from './rating-chart-display.factory'
import { ratingChartDisplayPage } from './rating-chart-display.page'

describe('RatingChartDisplay', () => {
  it('draws the line and leads with the signed change', async () => {
    ratingChartDisplayPage.render()

    await ratingChartDisplayPage.findChartCard()
    expect(ratingChartDisplayPage.queryChartLine()).toBeInTheDocument()
    expect(ratingChartDisplayPage.queryChangeChip()).toHaveTextContent('+127')
    expect(ratingChartDisplayPage.getChartSummary()).toBe(
      'Up 127 over the last 90 days',
    )
  })

  it('renders NO chip at all for a window with no rated matches — never “+0”', async () => {
    // The empty window is a first-class state (ADR-0915): the player has a rating,
    // they simply haven't played. "+0" would claim they played and went nowhere.
    ratingChartDisplayPage.render({ chart: buildEmptyChartView() })

    await ratingChartDisplayPage.findChartCard()
    expect(ratingChartDisplayPage.queryChangeChip()).toBeNull()
    expect(ratingChartDisplayPage.getChartSummary()).toBe(
      'No rated matches in the last 90 days',
    )
    // …and it still draws: a flat line at their current rating, not an empty box.
    expect(ratingChartDisplayPage.queryChartLine()).toBeInTheDocument()
  })

  it('shows an "N matches today" label instead of a spike when the whole history is one instant', async () => {
    // #957: a brand-new player who played several matches at one moment cannot be
    // drawn on a calendar axis — the line would be a sub-pixel spike hard against
    // the right edge. The card states the real count in words instead.
    ratingChartDisplayPage.render({ chart: buildSingleInstantChartView(6) })

    await ratingChartDisplayPage.findChartCard()
    expect(ratingChartDisplayPage.querySingleInstantLabel()).toHaveTextContent(
      '6 matches today',
    )
    // …and it does NOT draw the line: no SVG, no spike.
    expect(ratingChartDisplayPage.queryChartLine()).not.toBeInTheDocument()
  })

  it('pluralises the single-instant label — "1 match today", not "1 matches today"', async () => {
    ratingChartDisplayPage.render({ chart: buildSingleInstantChartView(1) })

    await ratingChartDisplayPage.findChartCard()
    expect(ratingChartDisplayPage.querySingleInstantLabel()).toHaveTextContent(
      '1 match today',
    )
  })

  it('puts a failed range IN the card — the SVG goes, the card stays', async () => {
    // The one card on the profile that fails in place. Everything else here shares
    // the bundle's query and throws to the route; a failed *range flip* must not
    // blank a profile that is otherwise perfectly painted.
    ratingChartDisplayPage.render({ isError: true, chart: null })

    await ratingChartDisplayPage.findChartCard()
    expect(await ratingChartDisplayPage.findChartError()).toHaveTextContent(
      'Couldn’t load that range',
    )
    expect(ratingChartDisplayPage.getRetry()).toBeInTheDocument()
    expect(ratingChartDisplayPage.queryChartLine()).not.toBeInTheDocument()
    // The tabs survive the failure — you can click straight back to the window
    // that worked.
    expect(ratingChartDisplayPage.getRangeTab('90d')).toBeInTheDocument()
  })

  it('keeps the previous line while another range loads, and stops quoting its numbers', async () => {
    // "Keep the old chart on screen" is half the requirement; the other half is
    // that the old chart's +127 must not sit under a caption reading "30d". The
    // picture stays, the numbers go quiet.
    ratingChartDisplayPage.render({
      range: '30d',
      chart: buildChartView(),
      isLoadingRange: true,
    })

    await ratingChartDisplayPage.findChartCard()
    expect(ratingChartDisplayPage.queryChartLine()).toBeInTheDocument()
    expect(ratingChartDisplayPage.isChartBusy()).toBe(true)
    expect(ratingChartDisplayPage.queryChangeChip()).toBeNull()
    expect(ratingChartDisplayPage.getChartSummary()).toBe(
      'Loading the last 30 days…',
    )
  })

  it('marks exactly one tab current, and links the default window to a CLEAN url', async () => {
    // The selection is the URL (ADR-0915). The default window is the *absence* of
    // the param — `?range=90d` must never appear in a link — and a second
    // "current" tab means the router's partial search matching won, which lights
    // up the default tab on every url.
    ratingChartDisplayPage.render({ range: '30d' })

    await ratingChartDisplayPage.findChartCard()
    expect(ratingChartDisplayPage.getSelectedRangeTab()).toHaveTextContent('30d')
    expect(ratingChartDisplayPage.getRangeTabHref('90d')).toBe('/players/p-1')
    expect(ratingChartDisplayPage.getRangeTabHref('30d')).toBe(
      '/players/p-1?range=30d',
    )
    expect(ratingChartDisplayPage.getRangeTabHref('1y')).toBe(
      '/players/p-1?range=1y',
    )
  })
})
