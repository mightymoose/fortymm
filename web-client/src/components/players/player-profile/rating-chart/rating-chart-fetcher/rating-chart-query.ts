import {
  DEFAULT_RATING_RANGE,
  ratingHistoryQueryOptions,
  type RatingHistoryWindow,
  type RatingPoint,
  type RatingRange,
} from '@/api/players'
import {
  formatRating,
  formatRatingDelta,
  formatRatingDeltaAria,
} from '@/lib/rating'

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

/* ------------------------------------------------- zoom-to-fit (#957) --
 * The calendar axis has a sharp edge (ADR-0915 amendment). A brand-new player's
 * whole history is one evening, so on a 30d/90d/1y axis every point shares almost
 * the same `x` and the series collapses to a ~1px vertical spike hard against the
 * right edge — the honest rendering of one instant on a calendar, and unusable.
 * These three constants size the fix.
 */

/** When the drawn line reaches back **less than this fraction** of the selected
 * window, the calendar axis is almost entirely empty and the series piles up on
 * the right edge — so the x-domain zooms to the data instead of running
 * window-start → now. 5%: an evening is *hours* against 30–365 days, far under
 * this; a player whose activity genuinely reaches back a meaningful slice of the
 * window stays on the full calendar domain, whose flat run is honest inactivity
 * (ADR-0915), not something to zoom away. */
const COLLAPSE_RANGE_FRACTION = 0.05

/** The tightest the zoomed axis goes — its minimum-span floor. Matches closer
 * together than this fan into a near-vertical cluster rather than being spread
 * edge-to-edge, which would imply hours between matches that were minutes (or
 * seconds) apart. Three hours reads as "one session". */
const MIN_SPAN_FLOOR_MS = 3 * 60 * 60 * 1000

/** Below this drawn x-extent (in viewBox units) even the floored zoom has not
 * separated the points: every match shares one instant (≈ now), so there is no
 * line to draw. The card shows an "N matches today" label instead of a spike. */
const SINGLE_INSTANT_MIN_SPAN = 1

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
/** Half a four-digit rating's width, in viewBox units — generously, since the
 * label is only *centred* on the dot while there is room for both of its halves.
 * (At font-size 9, a digit runs a little over 5 units wide.) */
const PEAK_LABEL_HALF_WIDTH = 12

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
  /** The high-water mark **of the drawn line** — see `peakVertex`, which is
   * where the choice of *which* vertex that is gets made. `null` for an empty
   * window (nothing was played, so nothing peaked), and never the profile's
   * *all-time* peak, which is a different number on the same page.
   *
   * `labelY` is the baseline the rating is printed at: **above** the dot when
   * there is room, **below** it when the peak sits at the top of the plot and
   * there is not. See `peakLabelBaseline`. `labelAnchor` is the same decision in
   * x: the label is centred on the dot only when both its halves fit inside the
   * plot, and grows inward off the edge when they don't. See `peakLabelAnchor`. */
  peak:
    | (ChartCoord & {
        rating: string
        labelY: number
        labelAnchor: PeakLabelAnchor
      })
    | null
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
  /**
   * The genuinely-single-instant fallback (#957), or **`null`** in every drawable
   * case.
   *
   * When a whole history is one instant — N matches recorded at the same moment,
   * ≈ now — the time axis cannot fan them out even after the minimum-span floor,
   * and the line above collapses to a sub-pixel spike. The card then renders an
   * "N matches today" label *in place of* the SVG. `matchCount` is the real number
   * of in-window matches, for the "1 match" / "6 matches" copy.
   */
  singleInstant: { matchCount: number } | null
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

/** Where the peak's label sits **horizontally**, given its dot's x. */
export type PeakLabelAnchor = 'start' | 'middle' | 'end'

/**
 * Which way the peak's label grows out of its dot.
 *
 * The vertical half of this was solved (`peakLabelBaseline`) and the horizontal
 * half was not: the label was *always* centred on the dot, so a peak at the right
 * edge of the plot — which is what a player whose latest match IS their high-water
 * mark has, x ≈ 590 of a plot that ends at 590 — pushed half a four-digit rating
 * off the end of the viewBox and straight through the "Today" axis label.
 *
 * So the label is anchored, not centred, whenever centring would not fit: it grows
 * **left** (`end`) off a peak against the right edge, **right** (`start`) off one
 * against the left edge — the anchor's vertex, which is drawn at `PLOT.left` — and
 * is centred everywhere in between, which is the usual case. Anchoring rather than
 * clamping the x keeps the label attached to the dot it names; a clamped centre
 * would slide the text away from its own marker. The baseline is untouched by
 * this, so the label still clears the dot vertically either way.
 */
export function peakLabelAnchor(dotX: number): PeakLabelAnchor {
  const plotRight = CHART_WIDTH - PLOT.right
  if (dotX + PEAK_LABEL_HALF_WIDTH > plotRight) return 'end'
  if (dotX - PEAK_LABEL_HALF_WIDTH < PLOT.left) return 'start'
  return 'middle'
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

/**
 * The vertex the peak marker sits on: the high-water mark of **the line the user
 * is looking at**, which is not always `window.peak`.
 *
 * `window.peak` is the highest point IN THE WINDOW (`api/app/ratings/history.py`),
 * and the anchor is by definition *not* in the window — but it IS drawn, and it
 * participates in the y-domain. So for any player whose rating fell across the
 * whole window (anchor above everything they got back to), reading `window.peak`
 * straight through put the "peak" dot BELOW the line's own leftmost vertex: the
 * anchor set `yMax` and started the line at the ceiling, while the marker labelled
 * a lower point as the high. The picture contradicted its own marker.
 *
 * So the peak is folded over the drawn vertices, and when the **anchor** is the
 * highest of them, it is what gets marked. That is the honest read of a marker
 * whose whole job is to say "this is the highest this line goes": the anchor is a
 * rating the player really held (it is what the window *opens* at), and the line
 * really does reach its apex there. Suppressing the marker on a declining window —
 * the alternative — would hide the number the eye is already drawn to, and leave
 * the line's most conspicuous vertex conspicuously unlabelled. It is drawn at the
 * domain's left edge rather than at its true (older) timestamp, exactly as
 * `vertices` draws it, so dot and line agree — no marker ever floats off the line.
 *
 * Two vertices are deliberately NOT candidates:
 *
 * - the **flat run to today** is synthetic — a duplicate of the last real rating,
 *   held level to the right-hand edge. It never wins here (it is not folded over),
 *   so a peak that IS the current rating stays marked on the real match that
 *   earned it rather than sliding to today's edge;
 * - an **empty window** (anchor, no points) marks nothing. `window.peak` is `null`
 *   there, and it stays `null`: the player did not play, so nothing peaked. The
 *   line is flat at the one rating they hold — a "peak" dot on a horizontal line
 *   would be noise, not information.
 *
 * Ties go to the in-window point (strict `>`), which keeps the marker on a real
 * match — at its real timestamp — whenever the anchor merely equals it.
 */
function peakVertex(
  window: RatingHistoryWindow,
  domainStart: number,
): Vertex | null {
  const inWindow = window.peak
  if (!inWindow) return null
  const anchor = window.anchor
  if (anchor && anchor.rating > inWindow.rating) {
    return { at: domainStart, rating: anchor.rating }
  }
  return { at: Date.parse(inWindow.at), rating: inWindow.rating }
}

/**
 * The x-axis's left-hand date — enough to place the edge in time without crowding
 * the axis.
 *
 * "Jun 11" while the edge is in the current year; **"Jul 11, 2025"** once it isn't.
 * The year is not decoration there: the 1y window's left edge is a year ago *to the
 * day*, so without it the axis read "Jul 11 … Today" — a label indistinguishable
 * from today's own date. (Keying on the year rather than on the range also catches
 * the 30d/90d windows that reach back across a new year, which are ambiguous for
 * exactly the same reason.)
 *
 * Local, like every other date the profile prints.
 */
const formatDay = (at: number, now: number): string => {
  const date = new Date(at)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

/** The x-domain the line is drawn into: normally window-start → now, but zoomed
 * to fit when the data has collapsed against the right edge. `collapsed` says
 * which branch was taken, so the caller knows a single-instant fallback is even
 * possible. */
type XDomain = { xMin: number; xMax: number; collapsed: boolean }

/**
 * Where the x-axis starts and ends (#957).
 *
 * The default is ADR-0915's calendar domain: `windowStart → now`, stretched back
 * to take in any point OLDER than the window start (the previous range's line,
 * held on screen while a flip loads — see `selectRatingChart`).
 *
 * The zoom-to-fit branch fires only when **there is no carry-in anchor**. An
 * anchor is drawn at the domain's left edge — it *is* the rating the window opens
 * at (ADR-0915) — so an anchored line already spans the plot edge-to-edge and can
 * never collapse; and re-homing the anchor onto a zoomed domain would misdate a
 * point whose whole meaning is "as of the window start". So an anchored window,
 * and the empty/unrated windows with no points at all, keep the full domain
 * unchanged.
 *
 * Without an anchor, the deciding measure is how far back the DRAWN line reaches:
 * from its earliest match to today (the line runs flat to now). That — not the
 * matches' own max−min span — is what tells "brand-new player, first session
 * tonight" (reaches back hours → zoom) apart from "played early, quiet since"
 * (reaches back the whole window → keep it; that flat run is the honest story).
 * When the reach is under `COLLAPSE_RANGE_FRACTION` of the window, the domain
 * zooms to the data, floored to `MIN_SPAN_FLOOR_MS`, with the right edge pinned at
 * now so the flat-run-to-today and the current dot are always in frame.
 */
function xDomain(
  window: RatingHistoryWindow,
  range: RatingRange,
  now: number,
  windowStart: number,
  pointTimes: number[],
): XDomain {
  const fullMin = Math.min(windowStart, ...pointTimes)
  const full: XDomain = { xMin: fullMin, xMax: now, collapsed: false }

  if (window.anchor || pointTimes.length === 0) return full

  const minPoint = Math.min(...pointTimes)
  const reach = now - minPoint
  const rangeSpan = RANGE_DAYS[range] * DAY_MS
  if (reach >= COLLAPSE_RANGE_FRACTION * rangeSpan) return full

  const xMin = Math.min(minPoint, now - MIN_SPAN_FLOOR_MS)
  return { xMin, xMax: now, collapsed: true }
}

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
  const pointTimes = window.points.map((point) => Date.parse(point.at))
  // The domain: the calendar window, stretched back to take in any point older
  // than it (the previous range's line, held on screen while this one loads) —
  // OR, when the data has collapsed against the right edge, zoomed to fit it
  // (#957). See `xDomain`.
  const { xMin, xMax, collapsed } = xDomain(
    window,
    range,
    now,
    windowStart,
    pointTimes,
  )
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

  // The genuinely-single-instant fallback (#957): the zoom branch was taken, yet
  // even the floored domain has not separated the drawn vertices — every match is
  // at one instant ≈ now, so the line is a sub-pixel spike. The card shows an
  // "N matches today" label rather than draw it. Measured on the DRAWN x-extent,
  // not the raw timestamps, so it is exactly "did the zoom fail to fan them".
  const drawnXs = coords.map((point) => point.x)
  const drawnXExtent = drawnXs.length
    ? Math.max(...drawnXs) - Math.min(...drawnXs)
    : 0
  const singleInstant =
    collapsed && drawnXExtent < SINGLE_INSTANT_MIN_SPAN
      ? { matchCount: window.points.length }
      : null

  const currentVertex = drawn.at(-1)
  // The peak of the DRAWN line, anchor included — not `window.peak` read straight
  // through, which marks the highest point *in the window* and so can sit below
  // the anchor the line starts at. See `peakVertex`.
  const peakPoint = peakVertex(window, xMin)
  const peakY = peakPoint ? y(peakPoint.rating) : 0
  const peakX = peakPoint ? x(peakPoint.at) : 0

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
          x: peakX,
          y: peakY,
          rating: formatRating(peakPoint.rating),
          labelY: peakLabelBaseline(peakY),
          labelAnchor: peakLabelAnchor(peakX),
        }
      : null,
    yTicks: [
      { label: formatRating(yMin), at: y(yMin) },
      { label: formatRating(yMax), at: y(yMax) },
    ],
    xTicks: [
      // The left-hand label names the edge the line actually starts at, which is
      // the window's start in every case but the transient one above.
      { label: formatDay(xMin, now), at: x(xMin) },
      { label: 'Today', at: x(xMax) },
    ],
    summary: summarize(window, range),
    change: changeChip(window.change),
    singleInstant,
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
  const rounded = Math.round(change)
  if (rounded === 0) return `No change over ${phrase}`
  const direction = rounded > 0 ? 'Up' : 'Down'
  // The **magnitude**, not the signed figure: the word already carries the sign,
  // and "Down -129" is a double negative that reads as a rise. (The chip beside it
  // keeps the signed "+127"/"-129" — that is a different convention, and there the
  // sign is the only thing saying which way it went.) This sentence is also the
  // chart's `aria-label`, so the picture's alt text said "Down -129" too.
  return `${direction} ${Math.abs(rounded)} over ${phrase}`
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
