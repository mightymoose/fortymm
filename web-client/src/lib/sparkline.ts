// The inset, in user units, between the data and the edges of the sparkline
// box — enough room for the stroke's round cap and the end-point dot to sit
// fully inside the viewBox instead of being clipped in half at the boundary.
const PAD = 2

/** A point on the sparkline's canvas, as `[x, y]` in the svg's user units. */
export type SparklinePoint = readonly [number, number]

export interface SparklineGeometry {
  /** Every data value mapped onto the padded `w × h` canvas, in series order. */
  points: SparklinePoint[]
  /** The trend line as an svg path `d` — `M`/`L` commands, 1 decimal place. */
  path: string
  /** The final point. Callers hang the end-point marker off it (an svg
   * `<circle>`, an HTML overlay dot) and close an area fill down from it, so
   * it stays unrounded — only `path` is rounded. */
  last: SparklinePoint
}

/**
 * Project a rating (or any numeric) series onto a `w × h` sparkline canvas:
 * evenly spaced along x, scaled to the series' own min/max along y with the
 * min at the bottom, and inset by a fixed padding on all sides.
 *
 * Shared by the two sparklines — the dashboard rating card's gradient-filled
 * hero and the match-details inline line (#194). They differ in chrome (fill,
 * colour, marker, dimensions), not in geometry, so only the math lives here;
 * each component keeps its own markup.
 *
 * A flat series (every value equal) has a zero range, which would divide by
 * zero — it's pinned to the baseline instead, the same reading as "no movement".
 * Expects at least two points; a shorter series has no line to draw and callers
 * withhold the sparkline entirely.
 */
export function sparklineGeometry(
  data: number[],
  w: number,
  h: number,
): SparklineGeometry {
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const points = data.map((v, i) => {
    const x = PAD + (i / (data.length - 1)) * (w - PAD * 2)
    const y = h - PAD - ((v - min) / range) * (h - PAD * 2)
    return [x, y] as const
  })
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join(' ')
  return { points, path, last: points[points.length - 1] }
}
