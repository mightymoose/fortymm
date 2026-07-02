import { render, screen, type Container } from '@/test/utilities'

import { NoMatchesCard } from './no-matches-card'

const scoped = (container: Container) => ({
  /** The overline label. */
  getOverline() {
    return container.getByText('Recent matches')
  },
  /** The headline empty-state copy. */
  getHeadline() {
    return container.getByText('No matches yet. Go play.')
  },
})

/** Test page-object for `NoMatchesCard` — the zero-match dashboard's
 * recent-matches empty state. Takes no props. */
export const noMatchesCardPage = {
  render() {
    render(<NoMatchesCard />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
