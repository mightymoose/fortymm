import { render, screen, type Container } from '@/test/utilities'

import { Mono, type MonoProps } from './mono'
import { buildMonoProps } from './mono.factory'

const scoped = (container: Container) => ({
  /** The monospace text span carrying `text`. */
  getText(text: string | RegExp) {
    return container.getByText(text)
  },
  queryText(text: string | RegExp) {
    return container.queryByText(text)
  },
})

/**
 * Test page-object for `Mono` — a styled text span with no role of its own, so
 * accessors resolve it by its rendered text. Owners that embed `Mono` spread
 * `within` to read the same text queries.
 */
export const monoPage = {
  render(overrides: Partial<MonoProps> = {}) {
    render(<Mono {...buildMonoProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
