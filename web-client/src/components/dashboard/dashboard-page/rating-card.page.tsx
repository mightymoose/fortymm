import { render, screen, within, type Container } from '@/test/utilities'

import { RatingCard, type RatingCardProps } from './rating-card'
import { buildRatingCardProps } from './rating-card.factory'
import { sparklinePage } from './rating-card/sparkline.page'

const scoped = (container: Container) => ({
  /** The hero rating numeral (e.g. "1612"). */
  getHeroRating(value: string) {
    return container.getByText(value)
  },
  /** The "<delta> last match" badge. */
  getDeltaBadge() {
    return container.getByText(/last match/i)
  },
  /** The win/loss streak badge by its label (e.g. "W3"), or null when absent. */
  queryStreakBadge(label: string) {
    return container.queryByText(label)
  },
  /** The "Top N%" percentile numeral, or null when unranked. */
  queryPercentile(text: string) {
    return container.queryByText(text)
  },
  /** Any element whose text matches — used to assert the league name line. */
  getByText(text: string | RegExp) {
    return container.getByText(text)
  },
  /** A stat tile addressed by its label overline (e.g. "Peak", "RD"). */
  getStatTile(label: string) {
    const tile = container.getByText(label).parentElement
    if (!tile) throw new Error(`No stat tile for "${label}"`)
    return tile
  },
})

/**
 * Test page-object for `RatingCard`. The card renders no links, so no router
 * harness is needed. The sparkline is a pure SVG queried via the captured
 * render container (see `sparkline()`).
 */
export const ratingCardPage = {
  root: null as HTMLElement | null,

  render(overrides: Partial<RatingCardProps> = {}) {
    const props = buildRatingCardProps(overrides)
    const { container } = render(<RatingCard {...props} />)
    this.root = container
  },

  /** The composed sparkline page object, scoped to this card's subtree. */
  sparkline() {
    if (!this.root) throw new Error('Call render() before sparkline()')
    return sparklinePage.within(this.root)
  },

  /** Scope the accessors to a subtree so a parent page object can reuse them. */
  within(node: HTMLElement) {
    return scoped(within(node))
  },

  ...scoped(screen),
}
