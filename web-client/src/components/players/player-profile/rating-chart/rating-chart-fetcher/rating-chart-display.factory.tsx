import {
  buildEmptyRatingWindow,
  buildRatingHistoryWindow,
} from '@/mocks/factories/players/rating-history.factory'

import type { RatingChartDisplayProps } from './rating-chart-display'
import { selectRatingChart, type ChartView } from './rating-chart-query'

/**
 * The view the card draws by default: a rated player's **90-day window**, up
 * **+127** from an anchor carried in from before it, peaking at 1701 in the
 * middle and standing at 1687 today.
 *
 * Built by running the real projection over the real wire fixture rather than by
 * hand-writing coordinates — so the props a display test renders are exactly the
 * ones the fetcher would hand it, and a change to the view model cannot leave the
 * card's tests passing against a shape nothing produces any more.
 */
export function buildChartView(window = buildRatingHistoryWindow()): ChartView {
  return selectRatingChart(window, '90d')
}

/** A rated player with **nothing in the window**: a flat line at their current
 * rating, "No rated matches in the last 90 days", and — the point — no change
 * chip at all. Never a "+0". */
export function buildEmptyChartView(): ChartView {
  return selectRatingChart(buildEmptyRatingWindow(), '90d')
}

/** Props for `RatingChartDisplay` — the settled, painted card. */
export function buildRatingChartDisplayProps(
  overrides: Partial<RatingChartDisplayProps> = {},
): RatingChartDisplayProps {
  return {
    playerId: 'p-1',
    range: '90d',
    chart: buildChartView(),
    isError: false,
    isLoadingRange: false,
    onRetry: () => {},
    ...overrides,
  }
}
