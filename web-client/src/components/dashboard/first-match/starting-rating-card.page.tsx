import { render, screen, type Container } from '@/test/utilities'

import { StartingRatingCard } from './starting-rating-card'

const scoped = (container: Container) => ({
  /** The seed rating value, "1500". */
  getRating() {
    return container.getByText('1500')
  },
  /** The PROVISIONAL badge. */
  getProvisionalBadge() {
    return container.getByText('Provisional')
  },
  /** The collapsed explainer trigger. */
  getExplainerTrigger() {
    return container.getByRole('button', {
      name: /why does everyone start at 1500/i,
    })
  },
  /** The RD figure, only present once the explainer is expanded. */
  queryRdText() {
    return container.queryByText(/RD 350/)
  },
})

/** Test page-object for `StartingRatingCard` — the zero-match dashboard's
 * static provisional-rating card. Takes no props (nothing here is fetched). */
export const startingRatingCardPage = {
  render() {
    render(<StartingRatingCard />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
