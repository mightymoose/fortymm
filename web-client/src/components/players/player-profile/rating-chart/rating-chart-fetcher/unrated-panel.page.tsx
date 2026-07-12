import { render, screen, within, type Container } from '@/test/utilities'

import { UnratedPanel } from './unrated-panel'

/** The whole of what the slot says. One sentence, one element: the hero owns the
 * page's only bare "Unrated". */
export const UNRATED_COPY = 'Unrated — finish a rated match to start your rating.'

const scoped = (container: Container) => ({
  /** The panel that stands where the chart would be for a player with no rating.
   * It shares the card's heading, so it is told apart from a real chart by what it
   * *doesn't* have: a line. */
  queryUnratedPanel(): HTMLElement | null {
    const card = container.queryByRole('region', { name: 'Rating over time' })
    if (!card) return null
    return within(card).queryByText(UNRATED_COPY)
  },
  findUnratedPanel() {
    return container.findByText(UNRATED_COPY)
  },
})

/**
 * Test page-object for `UnratedPanel` — what the chart's slot holds for a player
 * who has never finished a rated match.
 *
 * Pure markup, no router, no query: it exists to be *absent* of a chart.
 */
export const unratedPanelPage = {
  render() {
    render(<UnratedPanel />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
