import { render, screen, type Container } from '@/test/utilities'

import { ScorePadSide, type ScorePadSideProps } from './score-pad-side'
import { buildScorePadSideProps } from './score-pad-side.factory'

const scoped = (container: Container) => ({
  /** The numeric input, by its accessible label (`"<name> score"`). */
  getInput(name: string) {
    return container.getByLabelText(`${name} score`) as HTMLInputElement
  },
  /** This side's display name. */
  getName(name: string) {
    return container.getByText(name)
  },
})

/**
 * Test page-object for `ScorePadSide` — one participant's score input. Pure
 * presentational; `render` mounts it directly.
 */
export const scorePadSidePage = {
  render(overrides: Partial<ScorePadSideProps> = {}) {
    const props = buildScorePadSideProps(overrides)
    render(<ScorePadSide {...props} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
