import { render, screen, type Container } from '@/test/utilities'

import { OpponentOption, type OpponentOptionProps } from './opponent-option'
import { buildOpponentOptionProps } from './opponent-option.factory'

const scoped = (container: Container) => ({
  /** The option button, found by its accessible name (the player + role). */
  getOption(name: string | RegExp) {
    return container.getByRole('option', { name })
  },
  queryOption(name: string | RegExp) {
    return container.queryByRole('option', { name })
  },
})

/**
 * Test page-object for `OpponentOption` — a single listbox option. Covers the
 * combobox-option semantics (role, `aria-selected`), the decorative-avatar
 * accessible name, and the graceful fallback for degenerate usernames.
 */
export const opponentOptionPage = {
  render(overrides: Partial<OpponentOptionProps> = {}) {
    const props = buildOpponentOptionProps(overrides)
    render(<OpponentOption {...props} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
