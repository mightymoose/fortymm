export interface SparklineProps {
  /** The series to plot. Padding to ≥2 points is the caller's job (see
   * `projectRatingCardView`). */
  data: number[]
  /** Intrinsic viewBox width. */
  w?: number
  /** Height in px. */
  h?: number
  /** Stroke + fill color. */
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

/**
 * A compact trend line with a soft gradient fill and an end-point dot — the
 * dashboard rating card's 30-day sparkline. Pure presentational: geometry is
 * derived from `data`, which the caller must have padded to ≥2 points.
 */
export const Sparkline = ({
  data,
  w = 280,
  h = 48,
  color = 'var(--ball-500)',
  fluid = false,
}: SparklineProps) => {
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const pad = 2
  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (w - pad * 2)
    const y = h - pad - ((v - min) / range) * (h - pad * 2)
    return [x, y] as const
  })
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join(' ')
  const last = points[points.length - 1]
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
