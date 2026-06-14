import { render, screen, type Container } from '@/test/utilities'

import { StatusBadge, type StatusBadgeProps } from './status-badge'
import { buildStatusBadgeProps } from './status-badge.factory'

const scoped = (container: Container) => ({
  /** The status pill. Always present; `data-status` carries the raw status. */
  getBadge() {
    return container.getByTestId('tournament-status-badge')
  },
  queryBadge() {
    return container.queryByTestId('tournament-status-badge')
  },
})

/**
 * Test page-object for `StatusBadge`. Owners (the card, the detail hero) spread
 * `within` to expose the same pill query against their own subtree.
 */
export const statusBadgePage = {
  render(overrides: Partial<StatusBadgeProps> = {}) {
    render(<StatusBadge {...buildStatusBadgeProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
