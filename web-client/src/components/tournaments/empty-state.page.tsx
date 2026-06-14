import { render, screen, type Container } from '@/test/utilities'

import { EmptyState, type EmptyStateProps } from './empty-state'
import { buildEmptyStateProps } from './empty-state.factory'

const scoped = (container: Container) => ({
  queryTitle(title: string) {
    return container.queryByText(title)
  },
  queryHint(hint: string) {
    return container.queryByText(hint)
  },
})

/** Test page-object for `EmptyState`. */
export const emptyStatePage = {
  render(overrides: Partial<EmptyStateProps> = {}) {
    render(<EmptyState {...buildEmptyStateProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
