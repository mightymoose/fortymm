import { useId } from 'react'

import {
  CHART_HEIGHT,
  CHART_WIDTH,
  PLOT,
  type ChartView,
} from '../rating-chart-query'

export interface RatingChartSvgProps {
  chart: ChartView
  /** Accessible summary of the line — the sentence the card prints under its
   * heading, handed down so the picture and its caption cannot disagree. */
  summary: string
}

/**
 * The line itself: an area, a stroke, the peak, and where the player stands now.
 *
 * Hand-rolled SVG, and deliberately so — the repo has no charting library and a
 * rating line needs none. It draws **only what the view model hands it**: the two
 * path strings, the tick labels, and the coordinates of the two markers. Every
 * decision that could be wrong (where the anchor sits, that the line runs flat to
 * today, what the peak is, whether there is a change to report at all) was made in
 * `selectRatingChart`, where it is asserted against numbers rather than pixels.
 *
 * It scales by `viewBox` and nothing else: no measured widths, no resize
 * observers. That is what lets the same 600×180 drawing be a full-width panel on
 * a desktop and survive a 390px phone.
 *
 * `aria-hidden` on the drawing, with the sentence above it as the accessible
 * text: a screen-reader user gets "Up +127 over the last 90 days", which is the
 * chart's whole content, rather than a walk through forty `<path>` elements.
 */
export const RatingChartSvg = ({ chart, summary }: RatingChartSvgProps) => {
  const gradientId = useId()

  return (
    <svg
      className="rating-chart__svg"
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      role="img"
      aria-label={summary}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop
            offset="0%"
            stopColor="var(--ball-500)"
            stopOpacity="0.28"
          />
          <stop offset="100%" stopColor="var(--ball-500)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* The y-axis: a rating at the top of the range and one at the bottom. */}
      {chart.yTicks.map((tick) => (
        <g key={`y-${tick.label}`} aria-hidden="true">
          <line
            className="rating-chart__gridline"
            x1={PLOT.left}
            x2={CHART_WIDTH - PLOT.right}
            y1={tick.at}
            y2={tick.at}
          />
          <text
            className="rating-chart__y-label"
            x={PLOT.left - 6}
            y={tick.at + 3.5}
          >
            {tick.label}
          </text>
        </g>
      ))}

      {chart.area && (
        <path
          className="rating-chart__area"
          d={chart.area}
          fill={`url(#${gradientId})`}
          aria-hidden="true"
        />
      )}
      {chart.line && (
        <path
          className="rating-chart__line"
          d={chart.line}
          aria-hidden="true"
        />
      )}

      {/* The window's high-water mark. Absent from an empty window — nothing was
       * played, so nothing peaked. */}
      {chart.peak && (
        <g aria-hidden="true">
          <circle
            className="rating-chart__peak-dot"
            cx={chart.peak.x}
            cy={chart.peak.y}
            r="3.5"
          />
          <text
            className="rating-chart__peak-label"
            x={chart.peak.x}
            y={Math.max(10, chart.peak.y - 8)}
            textAnchor="middle"
          >
            {chart.peak.rating}
          </text>
        </g>
      )}

      {/* Where they stand today — the right-hand end of the line. */}
      <circle
        className="rating-chart__current-dot"
        cx={chart.current.x}
        cy={chart.current.y}
        r="4"
        aria-hidden="true"
      />

      {/* The x-axis: the window's left edge, and today. */}
      {chart.xTicks.map((tick, i) => (
        <text
          key={`x-${tick.label}`}
          className="rating-chart__x-label"
          x={tick.at}
          y={CHART_HEIGHT - 6}
          textAnchor={i === 0 ? 'start' : 'end'}
          aria-hidden="true"
        >
          {tick.label}
        </text>
      ))}
    </svg>
  )
}
