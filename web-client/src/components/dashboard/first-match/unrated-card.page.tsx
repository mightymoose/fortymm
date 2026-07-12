import { render, screen, type Container } from '@/test/utilities'

import { UnratedCard } from './unrated-card'

const scoped = (container: Container) => ({
  /** The card's headline: the word "Unrated", never a number. */
  getUnratedHeadline() {
    return container.getByText('Unrated')
  },
  /** Any run of 3-4 digits anywhere in the card — a rating-shaped number. This
   * card must never render one (#950), so the assertion is always that this is
   * absent; it guards the *shape*, not the literal 1500, so a future hardcode of
   * 1600 can't slip past. */
  queryRatingNumber() {
    return container.queryByText(/\b\d{3,4}\b/)
  },
  /** The confidence/provisional language the old card carried. */
  queryProvisionalBadge() {
    return container.queryByText(/provisional/i)
  },
  /** The collapsed explainer trigger. */
  getExplainerTrigger() {
    return container.getByRole('button', { name: /how does the ladder work/i })
  },
  /** The explainer body, only present once the explainer is expanded. */
  queryExplainerBody() {
    return container.queryByText(/rated matches you finish/i)
  },
})

/** Test page-object for `UnratedCard` — the zero-match dashboard's rating slot.
 * Takes no props: a player with no rated match has no rating to fetch, and this
 * card asserts nothing about them beyond that. */
export const unratedCardPage = {
  render() {
    render(<UnratedCard />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
