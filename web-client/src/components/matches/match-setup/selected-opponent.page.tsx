import { render, screen, type Container } from '@/test/utilities'

import { SelectedOpponent, type SelectedOpponentProps } from './selected-opponent'
import { buildSelectedOpponentProps } from './selected-opponent.factory'

const scoped = (container: Container) => ({
  /** The opponent's rendered display name. */
  getName(name: string | RegExp) {
    return container.getByText(name)
  },
  /** The rating/role secondary label. */
  getRoleLabel(label: string | RegExp) {
    return container.getByText(label)
  },
  /** The "Change" control that clears the picked opponent. */
  getChangeButton() {
    return container.getByRole('button', { name: 'Change' })
  },
})

/** Test page-object for `SelectedOpponent` — the picked-opponent pill. */
export const selectedOpponentPage = {
  render(overrides: Partial<SelectedOpponentProps> = {}) {
    render(<SelectedOpponent {...buildSelectedOpponentProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
