import { render, screen, type Container } from '@/test/utilities'

import { RatingCard, type RatingCardProps } from './rating-card'
import { buildRatingCardProps } from './rating-card.factory'
import { sparklinePage } from './rating-card/sparkline.page'

const scoped = (container: Container) => ({
  /** The big current-rating number (rounded for display). */
  getCurrentRating(value: number | string) {
    return container.getByText(String(value))
  },
  /** The "+24 last match" delta pill text. */
  getDeltaPill(text: string | RegExp) {
    return container.getByText(text)
  },
  /** The win/loss streak pill (e.g. "W3"), or null when there's no streak. */
  queryStreak(text: string | RegExp) {
    return container.queryByText(text)
  },
  /** The percentile fragment (e.g. "78%"), or null when percentile is null. */
  queryPercentile(text: string | RegExp) {
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

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
