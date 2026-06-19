import { render, screen, type Container } from '@/test/utilities'

import { Pill, type PillProps } from './pill'
import { buildPillProps } from './pill.factory'

const scoped = (container: Container) => ({
  /** The pill span carrying `text`. */
  getText(text: string | RegExp) {
    return container.getByText(text)
  },
  queryText(text: string | RegExp) {
    return container.queryByText(text)
  },
})

/**
 * Test page-object for `Pill` — a styled chip span with no role of its own, so
 * accessors resolve it by its rendered text. Owners that embed `Pill` spread
 * `within` to read the same text queries.
 */
export const pillPage = {
  render(overrides: Partial<PillProps> = {}) {
    render(<Pill {...buildPillProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
