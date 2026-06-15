import { render, screen, within, type Container } from '@/test/utilities'

import { Stat, type StatProps } from './stat'
import { buildStatProps } from './stat.factory'

const scoped = (container: Container) => ({
  /** The stat label overline (e.g. "Peak"). */
  getLabel(label: string) {
    return container.getByText(label)
  },
  /** The stat value (e.g. "1620"). */
  getValue(value: string) {
    return container.getByText(value)
  },
})

/** Test page-object for `Stat` — a leaf tile queried by its label/value text. */
export const statPage = {
  render(overrides: Partial<StatProps> = {}) {
    render(<Stat {...buildStatProps(overrides)} />)
  },

  /** Scope the accessors to a subtree so a parent page object can reuse them. */
  within(node: HTMLElement) {
    return scoped(within(node))
  },

  ...scoped(screen),
}
