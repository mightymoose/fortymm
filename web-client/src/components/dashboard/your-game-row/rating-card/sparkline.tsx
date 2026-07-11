import { C } from '@/components/dashboard/dashboard-tokens'
import { sparklineGeometry } from '@/lib/sparkline'

export interface SparklineProps {
  data: number[]
  w?: number
  h?: number
  color?: string
  /**
   * Fill the container width instead of rendering at the fixed `w`. Stretches
   * the SVG with `preserveAspectRatio="none"`, so the trend line's geometry
   * scales horizontally — fine for a sparkline (there's no canonical aspect),
   * and the line *weight* stays uniform via `vector-effect="non-scaling-stroke"`.
   * The end-point dot is drawn as an HTML overlay (below) rather than an SVG
   * `<circle>` precisely so it stays round instead of stretching into an ellipse.
   */
  fluid?: boolean
}

/** The rating-trend sparkline on the dashboard rating card — a gradient-filled
 * area under a stroked trend line, with an HTML-overlay end-point dot. Distinct
 * from the match-details sparkline (this one has the gradient fill, a `fluid`
 * stretch mode, and the overlay dots). Decorative: the svg is aria-hidden and
 * exposed only by `data-testid` since the rating value carries the info. */
export const Sparkline = ({
  data,
  w = 280,
  h = 48,
  color = C.ball500,
  fluid = false,
}: SparklineProps) => {
  const { path, last, pad } = sparklineGeometry(data, w, h)
  // Close the fill: down from the last point to the baseline, back along it to
  // under the first point — which sits at the helper's left inset, so ask the
  // helper for it rather than re-deriving it from the projected geometry.
  const areaPath = `${path} L${last[0]} ${h} L${pad} ${h} Z`
  const gradId = `dash-spark-${color.replace(/[^a-z0-9]/gi, '')}`
  // Position the end-point dot as a fraction of the box; since the overlay is a
  // sibling of the (possibly stretched) SVG, percentages keep it pinned to the
  // last data point regardless of the horizontal scale, while a fixed pixel
  // size keeps it circular.
  const dotLeft = `${(last[0] / w) * 100}%`
  const dotTop = `${(last[1] / h) * 100}%`
  return (
    <div
      data-testid="dashboard-sparkline"
      style={{
        position: 'relative',
        width: fluid ? '100%' : w,
        height: h,
        lineHeight: 0,
      }}
    >
      <svg
        width="100%"
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        // Stretch to fill when fluid; at fixed width the 1:1 mapping is undistorted.
        preserveAspectRatio={fluid ? 'none' : 'xMidYMid meet'}
        style={{ display: 'block', overflow: 'visible' }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill={`url(#${gradId})`} />
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: dotLeft,
          top: dotTop,
          width: 10,
          height: 10,
          marginLeft: -5,
          marginTop: -5,
          borderRadius: '50%',
          background: color,
          opacity: 0.25,
          pointerEvents: 'none',
        }}
      />
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: dotLeft,
          top: dotTop,
          width: 5.2,
          height: 5.2,
          marginLeft: -2.6,
          marginTop: -2.6,
          borderRadius: '50%',
          background: color,
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}
