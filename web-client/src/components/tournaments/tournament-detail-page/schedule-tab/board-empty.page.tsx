import { render, screen, type Container } from '@/test/utilities'

import { BoardEmpty, type BoardEmptyProps } from './board-empty'
import { buildBoardEmptyProps } from './board-empty.factory'

const scoped = (container: Container) => ({
  /** The whole empty panel — present only while nothing is placed. */
  queryEmpty() {
    return container.queryByTestId('schedule-board-empty')
  },
  getEmpty() {
    return container.getByTestId('schedule-board-empty')
  },

  within(node: Container = screen) {
    return scoped(node)
  },
})

/** Test page-object for `BoardEmpty` — the boards' no-placements state. */
export const boardEmptyPage = {
  render(overrides: Partial<BoardEmptyProps> = {}) {
    render(<BoardEmpty {...buildBoardEmptyProps(overrides)} />)
  },


  ...scoped(screen),
}
