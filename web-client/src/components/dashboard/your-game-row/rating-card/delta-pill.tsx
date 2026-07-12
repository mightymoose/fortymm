import { formatRatingDelta } from '@/lib/rating'

import { Pill } from './pill'

export interface DeltaPillProps {
  /**
   * How far the player's last rated match **moved** their rating.
   *
   * A `number`, and deliberately **not** `number | null`: this chip exists only
   * when there is a move to report. `DashboardRating.delta` is nullable — `null`
   * means the last rated match *established* the rating rather than moving it —
   * and the null case must be handled by *not rendering this component*, not by
   * passing the null in (#952).
   *
   * That is the whole point of the extraction. A tone is a claim about a
   * direction, and `null >= 0` is `false` in JS, so a nullable `delta` on this
   * prop would quietly paint a brand-new player's *established* rating as a
   * **loss** — the exact bug. Here, tsc rejects the null before it can be toned.
   */
  delta: number
}

/** The "+24 last match" chip beside the big rating: what the player's most
 * recent rated match did to them, signed and toned. Win-toned at zero or above,
 * loss-toned below. */
export const DeltaPill = ({ delta }: DeltaPillProps) => (
  <Pill tone={delta >= 0 ? 'win' : 'loss'} mono>
    {formatRatingDelta(delta)} last match
  </Pill>
)
