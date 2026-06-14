import { render, screen, type Container } from '@/test/utilities'

import { TimeCell, type TimeCellProps } from './time-cell'
import { buildTimeCellProps } from './time-cell.factory'

const scoped = (container: Container) => ({
  /** The `.strong` span holding the formatted time text. */
  getWhen(when: string = buildTimeCellProps().time.when) {
    return container.getByText(when)
  },
  queryWhen(when: string = buildTimeCellProps().time.when) {
    return container.queryByText(when)
  },
  /** The `.time-cell` wrapper element — the parent of the `.strong` span. */
  getTime(when: string = buildTimeCellProps().time.when) {
    return container.getByText(when).parentElement
  },
})

/**
 * Test page-object for `TimeCell` — the created-at cell in a match row. A leaf
 * with no router or async paint, so tests use `get*` accessors directly.
 */
export const timeCellPage = {
  render(overrides: Partial<TimeCellProps> = {}) {
    const props = buildTimeCellProps(overrides)
    render(<TimeCell {...props} />)
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. The match-row page object spreads this to expose
   * the same queries as its own, rather than re-deriving them.
   */
  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
