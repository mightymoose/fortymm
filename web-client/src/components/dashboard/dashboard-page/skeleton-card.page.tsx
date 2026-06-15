import { render, screen, within, type Container } from '@/test/utilities'

import { SkeletonCard, type SkeletonCardProps } from './skeleton-card'
import { buildSkeletonCardProps } from './skeleton-card.factory'

const scoped = (container: Container) => ({
  /** The busy `role="status"` placeholder, addressed by its label. */
  getStatus(label: string) {
    return container.getByRole('status', { name: label })
  },
  queryStatus(label: string) {
    return container.queryByRole('status', { name: label })
  },
})

/** Test page-object for `SkeletonCard` — a labeled loading placeholder. */
export const skeletonCardPage = {
  render(overrides: Partial<SkeletonCardProps> = {}) {
    render(<SkeletonCard {...buildSkeletonCardProps(overrides)} />)
  },

  /** Scope the accessors to a subtree so a parent page object can reuse them. */
  within(node: HTMLElement) {
    return scoped(within(node))
  },

  ...scoped(screen),
}
