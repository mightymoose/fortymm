import { render, screen, type Container } from '@/test/utilities'

import { PoolsSection, type PoolsSectionProps } from './pools-section'
import { buildPoolsSectionProps } from './pools-section.factory'
import { poolCardPage } from './pools-section/pool-card.page'

const scoped = (container: Container) => ({
  getAddPoolButton() {
    return container.getByRole('button', { name: /Add (first )?pool/ })
  },
  queryPoolCards() {
    return container.queryAllByTestId('pool-card')
  },
  queryConflictAlert() {
    return container.queryByRole('alert')
  },
  ...poolCardPage.within(container),
})

/** Test page-object for `PoolsSection`. */
export const poolsSectionPage = {
  render(overrides: Partial<PoolsSectionProps> = {}) {
    render(<PoolsSection {...buildPoolsSectionProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
