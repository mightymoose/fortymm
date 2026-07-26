import { useId } from 'react'

import type { RatingRange } from '@/api/players'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { RangeTabs } from './rating-chart-display/range-tabs'
import { RatingChartSvg } from './rating-chart-display/rating-chart-svg'
import { rangeLoadingLabel, type ChartView } from './rating-chart-query'

export interface RatingChartDisplayProps {
  /** The profile the range tabs link back to. */
  playerId: string
  /** The window the tabs mark as current — and the one the card *claims* to be
   * showing, which is why its caption goes quiet while another one loads. */
  range: RatingRange
  /** The line to draw, or `null` when there is nothing yet (a cold range with no
   * seed and no previous data) or nothing left (a failed fetch with no previous
   * data to fall back on). */
  chart: ChartView | null
  /** The fetch for `range` failed. The card says so **in place of the SVG** and
   * offers a retry; the rest of the profile is untouched. */
  isError: boolean
  /** The line on screen is not `range`'s: either the previous range's, held
   * there while the new one loads, or nothing at all. */
  isLoadingRange: boolean
  onRetry: () => void
}

/**
 * The rating chart's card: a heading, the signed change, the range tabs, a
 * sentence, and the line.
 *
 * The card is the **error boundary of last resort for a range flip**, and that is
 * the one thing about it that is not like the other cards on this page (ADR-0915).
 * The other six share the profile bundle's query and throw to the route: if that
 * request fails, none of them has anything to draw and a whole-page error is the
 * honest answer. Here it is the opposite — the page is painted, the profile is
 * fine, and one narrow request for one window failed. So the failure renders
 * exactly where the picture would be, under the tabs that caused it, with a Try
 * again beside it. Blanking a fully-painted profile because someone clicked "30d"
 * would be absurd.
 *
 * Two smaller honesty rules the card holds:
 *
 * - while a new range loads, the **previous line stays on screen** — but the
 *   caption and the change chip do not, because they would be quoting the old
 *   window's numbers under the new window's name. The picture is a picture; a
 *   number with the wrong label is a lie;
 * - there is **no "+0"**. An empty window carries no change (the player did not
 *   play), and the view model refuses to invent one — the card simply has no chip
 *   to render, and its sentence says "No rated matches in the last 90 days".
 */
export const RatingChartDisplay = ({
  playerId,
  range,
  chart,
  isError,
  isLoadingRange,
  onRetry,
}: RatingChartDisplayProps) => {
  const id = useId()
  // The chip and the caption speak for `range`. While another window is loading,
  // the line on screen belongs to the last one — so they say nothing rather than
  // something wrong.
  const isSettled = !isLoadingRange && !isError
  const change = isSettled ? chart?.change : null

  return (
    <section
      className="player-profile__section rating-chart"
      aria-labelledby={id}
    >
      <div className="player-profile__section-header rating-chart__header">
        <h2 className="player-profile__section-title" id={id}>
          Rating over time
        </h2>
        {change && (
          <span
            className={cn(
              'rating-chart__chip',
              `rating-chart__chip--${change.tone}`,
            )}
            aria-label={change.aria}
          >
            {change.label}
          </span>
        )}
        <RangeTabs playerId={playerId} range={range} />
      </div>

      <p className="rating-chart__summary">
        {isError
          ? 'That range didn’t load.'
          : isLoadingRange
            ? rangeLoadingLabel(range)
            : (chart?.summary ?? '')}
      </p>

      <div className="rating-chart__plot">
        {isError ? (
          <div className="rating-chart__error" role="alert">
            <p className="rating-chart__error-title">
              Couldn’t load that range
            </p>
            <Button variant="ghost" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : chart ? (
          <div
            className={cn(
              'rating-chart__canvas',
              isLoadingRange && 'rating-chart__canvas--loading',
            )}
            // The old line is still the truth about the old window — it is just
            // no longer the window being asked about. Busy, not gone.
            aria-busy={isLoadingRange || undefined}
          >
            <RatingChartSvg chart={chart} summary={chart.summary} />
          </div>
        ) : (
          <div
            className="rating-chart__pending"
            role="status"
            aria-label="Loading chart data"
          >
            <span className="rating-chart__pending-bar" aria-hidden="true" />
          </div>
        )}
      </div>
    </section>
  )
}
