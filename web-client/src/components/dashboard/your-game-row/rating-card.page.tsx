import { render, screen, type Container } from '@/test/utilities'

import { RatingCard, type RatingCardProps } from './rating-card'
import {
  buildEstablishedRatingCardProps,
  buildRatingCardProps,
} from './rating-card.factory'
import { deltaPillPage } from './rating-card/delta-pill.page'
import { sparklinePage } from './rating-card/sparkline.page'

const scoped = (container: Container) => ({
  /** The big current-rating number (rounded for display).
   *
   * Resolved by the hero's 56px face, not by text alone: a player one rated
   * match old peaks *at* their current rating, so the same digits also appear in
   * the Peak tile. Matching the hero specifically keeps "the card shows their
   * rating" from passing on the strength of the Peak tile. */
  getCurrentRating(value: number | string) {
    const hero = (container.getAllByText(String(value)) as HTMLElement[]).find(
      (el) => el.style.font.includes('56px'),
    )
    if (!hero) {
      throw new Error(`no hero rating "${value}" (56px mono) on the card`)
    }
    return hero
  },
  /** The win/loss streak pill (e.g. "W3"), or null when there's no streak. */
  queryStreak(text: string | RegExp) {
    return container.queryByText(text)
  },
  /** The percentile fragment (e.g. "78%"), or null when percentile is null. */
  queryPercentile(text: string | RegExp) {
    return container.queryByText(text)
  },
  /** The rank line shown below the percentile threshold ("#N of M"). Pass a
   * regex — the line reads "#N of M in <league>" as one span, so an exact string
   * won't match the whole node. Null when rank isn't shown. */
  queryRank(text: RegExp) {
    return container.queryByText(text)
  },
  /** A stat tile resolved by its label (e.g. "Peak", "RD"); null when absent. */
  queryStatLabel(label: string) {
    return container.queryByText(label)
  },
  /** Any text fragment in the card — for values that no role/label isolates
   * (e.g. a stat tile's monospace value). */
  queryText(text: string | RegExp) {
    return container.queryByText(text)
  },
  // The "+24 last match" chip is owned by the delta-pill quartet — `getDeltaPill`
  // / `queryDeltaPill` come from there, so "no chip at all" (an *established*
  // rating) is asserted through the same accessor everywhere.
  ...deltaPillPage.within(container),
  // The decorative trend line is owned and pinned by the sparkline quartet;
  // expose its queries so owners can confirm it was wired in.
  ...sparklinePage.within(container),
})

/**
 * Test page-object for `RatingCard` — the "current rating" hero card. It reads
 * a `DashboardRating` and renders the number, delta/streak pills, percentile
 * line, sparkline, and stat tiles. Owners (YourGameRow) spread `within` to
 * expose these as their own.
 */
export const ratingCardPage = {
  render(overrides: Partial<RatingCardProps> = {}) {
    render(<RatingCard {...buildRatingCardProps(overrides)} />)
  },

  /** Render the card as a player whose ONE rated match established their rating
   * (`delta: null`) — the state that must show the number and no chip (#952). */
  renderEstablished(overrides: Partial<RatingCardProps> = {}) {
    render(<RatingCard {...buildEstablishedRatingCardProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
