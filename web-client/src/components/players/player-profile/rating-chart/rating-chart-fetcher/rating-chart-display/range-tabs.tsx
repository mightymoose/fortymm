import { Link } from '@tanstack/react-router'

import { DEFAULT_RATING_RANGE, RATING_RANGES, type RatingRange } from '@/api/players'
import { cn } from '@/lib/utils'

import { RANGE_LABELS } from '../rating-chart-query'

export interface RangeTabsProps {
  /** The profile the tabs link back to — each tab is a link to *this same page*,
   * with a different window selected. */
  playerId: string
  /** The window currently drawn. */
  range: RatingRange
}

/**
 * The chart's window picker — 30d / 90d / 1y.
 *
 * Real `<Link>`s, not buttons, for the same reason the Leagues card's rows are:
 * the selection **is** the URL (ADR-0915). It has to survive a reload, be
 * shareable, and answer to the back button. Two details follow:
 *
 * - the **default** window's tab links to a URL with **no `?range=` at all**. A
 *   URL that names no range means the default one, so the clean URL and the
 *   explicit one say the same thing — and the clean one is what almost every
 *   visit should carry;
 * - `search` is an **updater**, not a replacement: flipping the range must not
 *   drop the `?league=` the page may also be carrying.
 *
 * `aria-current="page"` marks the drawn window — the router stamps the same
 * attribute on any link it considers active, and `activeOptions={{ exact: true }}`
 * is what stops it deciding that the default tab (whose search is `{}`) is active
 * on *every* URL, which would light up two tabs at once.
 */
export const RangeTabs = ({ playerId, range }: RangeTabsProps) => (
  <div className="rating-chart__tabs" role="group" aria-label="Chart range">
    {RATING_RANGES.map((option) => (
      <Link
        key={option}
        to="/players/$userId"
        params={{ userId: playerId }}
        search={(prev) => ({
          ...prev,
          range: option === DEFAULT_RATING_RANGE ? undefined : option,
        })}
        activeOptions={{ exact: true }}
        className={cn(
          'rating-chart__tab',
          option === range && 'rating-chart__tab--selected',
        )}
        aria-current={option === range ? 'page' : undefined}
      >
        {RANGE_LABELS[option]}
      </Link>
    ))}
  </div>
)
