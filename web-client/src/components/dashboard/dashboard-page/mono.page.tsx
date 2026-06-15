import { render, screen, within, type Container } from '@/test/utilities'

import { Mono, type MonoProps } from './mono'
import { buildMonoProps } from './mono.factory'

const scoped = (container: Container) => ({
  /** The mono `<span>`, resolved by its rendered text. */
  get(text: string | RegExp) {
    return container.getByText(text)
  },
})

/** Test page-object for `Mono` — a leaf tabular-numeral span queried by text. */
export const monoPage = {
  render(overrides: Partial<MonoProps> = {}) {
    const props = buildMonoProps(overrides)
    render(<Mono {...props} />)
  },

  /** Scope the accessors to a subtree so a parent page object can reuse them. */
  within(node: HTMLElement) {
    return scoped(within(node))
  },

  ...scoped(screen),
}
