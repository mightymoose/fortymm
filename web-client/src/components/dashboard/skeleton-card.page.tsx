import { render, screen, type Container } from '@/test/utilities'

import { SkeletonCard, type SkeletonCardProps } from './skeleton-card'
import { buildSkeletonCardProps } from './skeleton-card.factory'

const scoped = (container: Container) => ({
  /** The busy status placeholder, resolved by its `aria-label`. */
  getSkeleton(label = 'Loading') {
    return container.getByRole('status', { name: label })
  },
  querySkeleton(label = 'Loading') {
    return container.queryByRole('status', { name: label })
  },
})

/**
 * Test page-object for `SkeletonCard` — a loading placeholder exposing a busy
 * `status` role, so accessors resolve it by role and accessible name. Owners
 * that embed `SkeletonCard` spread `within` to read the same status queries.
 */
export const skeletonCardPage = {
  render(overrides: Partial<SkeletonCardProps> = {}) {
    render(<SkeletonCard {...buildSkeletonCardProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
