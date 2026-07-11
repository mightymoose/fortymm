import {
  DEFAULT_RATING_RANGE,
  ratingHistoryQueryOptions,
  type RatingHistoryWindow,
  type RatingPoint,
  type RatingRange,
} from '@/api/players'
import { formatRatingDelta, formatRatingDeltaAria } from '@/lib/rating'

/**
 * The chart's own query — `GET /v1/players/{id}/rating-history?league_id=&range=`.
 *
 * Re-exported here so the card reads its query from one place, next to the
 * projection that turns the answer into a picture. Everything that makes it
 * *unlike* the other six cards' queries — no `throwOnError`, its own cache key,
 * the `staleTime` that keeps its seeded first paint from being refetched — lives
 * on the options in `@/api/players`; see `ratingHistoryQueryOptions`.
 */
export const ratingChartQuery = ratingHistoryQueryOptions

/** How many days each window spans. Mirrors `window_start` in
 * `api/app/ratings/history.py` — the client draws the same window the server
 * read. */
const RANGE_DAYS: Record<RatingRange, number> = {
  '30d': 30,
  '90d': 90,
  '1y': 365,
}

/** How the range reads in a sentence: "…over the last **90 days**". */
const RANGE_PHRASE: Record<RatingRange, string> = {
  '30d': 'the last 30 days',
  '90d': 'the last 90 days',
  '1y': 'the last year',
}

/** The tab's own label. */
export const RANGE_LABELS: Record<RatingRange, string> = {
  '30d': '30d',
  '90d': '90d',
  '1y': '1y',
}

/** What the card says while a *different* window is being fetched and the
 * previous one is still on screen. It names the window it is waiting for, so the
 * caption never sits over a line it doesn't describe. */
export const rangeLoadingLabel = (range: RatingRange): string =>
  `Loading ${RANGE_PHRASE[range]}…`

const DAY_MS = 24 * 60 * 60 * 1000

/* ---------------------------------------------------------------- geometry --
 * The chart is drawn in **viewBox units**, never pixels: one `viewBox` scaled by
 * CSS is what lets the same SVG survive a 390px phone and a 1400px desktop
 * without re-measuring anything at runtime.
 */
export const CHART_WIDTH = 600
export const CHART_HEIGHT = 180
/** Room for the y-axis rating labels (left) and the x-axis date labels
 * (bottom). Exported so the SVG's gridlines start where the plot does rather
 * than at a second, drifting copy of the number. */
export const PLOT = { left: 42, right: 10, top: 12, bottom: 24 }
const PLOT_WIDTH = CHART_WIDTH - PLOT.left - PLOT.right
const PLOT_HEIGHT = CHART_HEIGHT - PLOT.top - PLOT.bottom

/** The y-range a FLAT line is given, so it sits in the middle of the plot
 * instead of on an axis with a zero-height domain (which would divide by zero
 * and paint every point at `NaN`). */
const FLAT_PADDING = 20

/* ------------------------------------------------------- the peak's label --
 * The peak carries a dot AND its rating, and the two must not sit on top of each
 * other. The label normally rides ABOVE the dot — but the peak is very often the
 * top of the y-domain, which puts it at `PLOT.top` (12), and there is no room
 * above 12 for a 9-unit-tall label plus a 3.5-radius dot. Clamping the baseline
 * to the top edge (what this used to do) does not avoid the collision, it *is*
 * the collision: a baseline of 10 draws the digits straight through a dot that
 * spans 8.5–15.5.
 *
 * So when there is no room above, the label flips BELOW the dot. Both placements
 * are computed here, in the view model, rather than in the SVG — same rule as
 * every other coordinate on this chart: the drawing draws, the numbers are
 * decided (and asserted) here.
 */
/** The peak marker's radius, in viewBox units — must match the `r` the SVG draws. */
const PEAK_DOT_RADIUS = 3.5
/** Clear air between the dot's edge and the label, above or below. */
const PEAK_LABEL_GAP = 4.5
/** The label's font-size in viewBox units (`.rating-chart__peak-label`), which is
 * also how far a baseline must sit below the top edge to render un-clipped. */
const PEAK_LABEL_SIZE = 9

export type ChartCoord = { x: number; y: number }

export type ChartAxisTick = {
  /** What the tick prints — a rating, or a date. */
  label: string
  /** Its position along its axis, in viewBox units. */
  at: number
}

/** The signed movement across the window, as the card prints it. */
export type ChartChangeView = {
  /** e.g. "+127" / "-43". */
  label: string
  /** "Gained 127 rating" — the chip's glyphs don't read aloud. */
  aria: string
  tone: 'up' | 'down'
}

export type ChartView = {
  /** `d` for the line: anchor → in-window points → a flat run to today. */
  line: string
  /** The same shape closed down to the baseline, for the area fill. */
  area: string
  /** Where the player is **now** — the line's right-hand end. */
  current: ChartCoord & { rating: string }
  /** The window's high-water mark. `null` for an empty window (nothing was
   * played, so nothing peaked) — and never the profile's *all-time* peak, which
   * is a different number on the same page.
   *
   * `labelY` is the baseline the rating is printed at: **above** the dot when
   * there is room, **below** it when the peak sits at the top of the plot and
   * there is not. See `peakLabelBaseline`. */
  peak: (ChartCoord & { rating: string; labelY: number }) | null
  /** Rating labels up the left-hand side, bottom-first. */
  yTicks: ChartAxisTick[]
  /** Date labels along the bottom. */
  xTicks: ChartAxisTick[]
  /** "Up +127 over the last 90 days", "Down -43 over the last 90 days", or —
   * for a window with nothing in it — "No rated matches in the last 90 days". */
  summary: string
  /**
   * The change chip, or **`null`**.
   *
   * `null` in the two cases where a number would be a lie: an empty window (the
   * API sends `change: null` — the player did not play, so there is no movement
   * to report), and a window that netted exactly zero. Neither may render as
   * "+0": that reads as "played, and went nowhere", which in the first case is
   * false and in the second is better said in words than in a chip.
   */
  change: ChartChangeView | null
  /** True when the window holds no rated matches at all: the line is flat at the
   * player's current rating, and it is a real answer rather than an error. */
  isEmptyWindow: boolean
}

const round = (value: number): number => Math.round(value * 100) / 100

/**
 * Where the peak's rating is printed, given where its dot sits.
 *
 * Above the dot by default. Below it when the dot is high enough in the plot that
 * a label above would run off the top of the viewBox — which is the *common* case,
 * not an exotic one: the peak of a window is usually the top of that window's
 * y-domain, i.e. `PLOT.top`, and a label 8 units above 12 has nowhere to go. It
 * used to be clamped to a baseline of 10, which drew the digits through the dot.
 */
export function peakLabelBaseline(dotY: number): number {
  const above = dotY - PEAK_DOT_RADIUS - PEAK_LABEL_GAP
  // The text grows upward from its baseline, so it only clears the top edge when
  // the baseline is at least its own height below it.
  if (above >= PEAK_LABEL_SIZE) return above
  return round(dotY + PEAK_DOT_RADIUS + PEAK_LABEL_GAP + PEAK_LABEL_SIZE)
}

/** A drawn vertex: a rating at an instant, in milliseconds. */
type Vertex = { at: number; rating: number }

/**
 * The vertices of the drawn line: **anchor → in-window points → today**.
 *
 * Each of the three is load-bearing (ADR-0915).
 *
 * The **anchor** is the player's rating *as of the window start*, and it is a
 * point from OUTSIDE the window — the last change at or before the left edge. It
 * is plotted AT the left edge, because that is what it means: on day one of the
 * window, this is what they were rated. Without it the line would start at
 * whatever their first match in the window happened to be, and the headline
 * change would be measured from the wrong number.
 *
 * The **flat run to today** is the other half of the same honesty: a rating does
 * not decay while you are not playing. Your last rated match may have been three
 * weeks ago; your rating today is still your rating, and the line says so by
 * running level to the right-hand edge.
 */
function vertices(
  window: RatingHistoryWindow,
  domainStart: number,
  now: number,
): Vertex[] {
  const points: Vertex[] = window.points.map((point: RatingPoint) => ({
    at: Date.parse(point.at),
    rating: point.rating,
  }))
  const drawn: Vertex[] = []
  if (window.anchor) {
    // Drawn at the **left edge of the domain**, not at its own timestamp: its real
    // one is older than the window (that is what makes it an anchor), but its
    // *value* is the rating the window opens at. Pinning it to the edge — rather
    // than to `now - range`, which is the same thing right up until the card is
    // holding a longer range's line while a shorter one loads — is also what keeps
    // the line monotonic in x, instead of doubling back on itself.
    drawn.push({ at: domainStart, rating: window.anchor.rating })
  }
  drawn.push(...points)
  const last = drawn.at(-1)
  if (last && last.at < now) drawn.push({ at: now, rating: last.rating })
  return drawn
}

/** Rounded to whole rating points — a chart is not the place for "1687.4". */
const formatRating = (rating: number): string => String(Math.round(rating))

/** "12 Mar" — enough to place a point in the year without crowding the axis. */
const formatDay = (at: number): string =>
  new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

/**
 * The chart, projected out of one window of rating history.
 *
 * A pure function of `(window, range, now)` — every decision the picture makes is
 * made here, and the SVG below it is a dumb view: it draws the two path strings
 * and prints the labels it is handed. That is deliberate. The interesting claims
 * ("the line starts at the anchor, not at the first match in the window", "an
 * empty window is flat at the current rating and shows no +0") are claims about
 * *numbers*, and they are asserted against numbers here rather than against
 * rendered pixels.
 *
 * The x-domain deserves a note. It runs from the window's start to now — except
 * that it stretches back to take in any point OLDER than the window start, which
 * happens for exactly one reason: while a range flip is in flight the card keeps
 * the **previous** range's data on screen (`keepPreviousData`), and re-projecting
 * a 90-day line into a 30-day domain would pile two thirds of it up on the left
 * edge. Widening the domain to fit the data draws the old line as itself until
 * the new one lands.
 */
export function selectRatingChart(
  window: RatingHistoryWindow,
  range: RatingRange = DEFAULT_RATING_RANGE,
  now: number = Date.now(),
): ChartView {
  const windowStart = now - RANGE_DAYS[range] * DAY_MS
  // The domain's left edge: the window's, stretched back to take in any point
  // older than it (see above — that is the previous range's line, held on screen
  // while this one loads).
  const xMin = Math.min(
    windowStart,
    ...window.points.map((point) => Date.parse(point.at)),
  )
  const xMax = now
  const xSpan = Math.max(1, xMax - xMin)
  const drawn = vertices(window, xMin, now)

  const ratings = drawn.map((vertex) => vertex.rating)
  const low = ratings.length ? Math.min(...ratings) : 0
  const high = ratings.length ? Math.max(...ratings) : 0
  // A flat line has a zero-height domain. Give it room rather than dividing by
  // zero — every coordinate would come out `NaN` and the SVG would silently
  // render nothing.
  const yMin = low === high ? low - FLAT_PADDING : low
  const yMax = low === high ? high + FLAT_PADDING : high
  const ySpan = Math.max(1, yMax - yMin)

  const x = (at: number) =>
    round(PLOT.left + ((at - xMin) / xSpan) * PLOT_WIDTH)
  const y = (rating: number) =>
    round(PLOT.top + (1 - (rating - yMin) / ySpan) * PLOT_HEIGHT)

  const coords = drawn.map((vertex) => ({
    x: x(vertex.at),
    y: y(vertex.rating),
  }))
  const line = coords
    .map((point, i) => `${i === 0 ? 'M' : 'L'}${point.x} ${point.y}`)
    .join(' ')
  const baseline = CHART_HEIGHT - PLOT.bottom
  const first = coords[0]
  const last = coords.at(-1)
  const area =
    first && last
      ? `${line} L${last.x} ${baseline} L${first.x} ${baseline} Z`
      : ''

  const currentVertex = drawn.at(-1)
  const peakPoint = window.peak
  const peakY = peakPoint ? y(peakPoint.rating) : 0

  return {
    line,
    area,
    current: {
      x: last?.x ?? PLOT.left,
      y: last?.y ?? PLOT.top,
      rating: currentVertex ? formatRating(currentVertex.rating) : '',
    },
    peak: peakPoint
      ? {
          x: x(Date.parse(peakPoint.at)),
          y: peakY,
          rating: formatRating(peakPoint.rating),
          labelY: peakLabelBaseline(peakY),
        }
      : null,
    yTicks: [
      { label: formatRating(yMin), at: y(yMin) },
      { label: formatRating(yMax), at: y(yMax) },
    ],
    xTicks: [
      // The left-hand label names the edge the line actually starts at, which is
      // the window's start in every case but the transient one above.
      { label: formatDay(xMin), at: x(xMin) },
      { label: 'Today', at: x(xMax) },
    ],
    summary: summarize(window, range),
    change: changeChip(window.change),
    isEmptyWindow: window.points.length === 0,
  }
}

/**
 * The sentence under the heading.
 *
 * The empty window gets its own, and it is not an apology: a rated player who
 * has not played in ninety days has a rating, and it has not moved. Saying "No
 * rated matches in the last 90 days" is the truth; saying "+0 over the last 90
 * days" would claim they played and went nowhere.
 */
function summarize(window: RatingHistoryWindow, range: RatingRange): string {
  const phrase = RANGE_PHRASE[range]
  const change = window.change
  if (change == null) return `No rated matches in ${phrase}`
  if (Math.round(change) === 0) return `No change over ${phrase}`
  const direction = change > 0 ? 'Up' : 'Down'
  return `${direction} ${formatRatingDelta(change)} over ${phrase}`
}

/** The chip — or nothing at all. Never a "+0" (ADR-0915). */
function changeChip(change: number | null | undefined): ChartChangeView | null {
  if (change == null) return null
  const rounded = Math.round(change)
  if (rounded === 0) return null
  return {
    label: formatRatingDelta(rounded),
    aria: formatRatingDeltaAria(rounded),
    tone: rounded > 0 ? 'up' : 'down',
  }
}
