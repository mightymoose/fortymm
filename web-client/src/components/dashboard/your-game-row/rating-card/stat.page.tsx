import { render, screen, type Container } from '@/test/utilities'

import { monoPage } from '../mono.page'
import { Stat, type StatProps } from './stat'
import { buildStatProps } from './stat.factory'

const scoped = (container: Container) => ({
  /** The overline caption carrying the stat's `text` label. */
  getLabel(text: string | RegExp) {
    return container.getByText(text)
  },
  ...monoPage.within(container),
})

/**
 * Test page-object for `Stat` — a label/value tile. It composes `monoPage` so
 * the value is queryable through the same monospace text accessors, and adds a
 * `getLabel` accessor for the overline caption.
 */
export const statPage = {
  render(overrides: Partial<StatProps> = {}) {
    render(<Stat {...buildStatProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
