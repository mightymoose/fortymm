import { render, screen, type Container } from '@/test/utilities'

import { PoolCard, type PoolCardProps } from './pool-card'
import { buildPoolCardProps } from './pool-card.factory'

const scoped = (container: Container) => ({
  getCard() {
    return container.getByTestId('pool-card')
  },
  getNameInput() {
    return container.getByLabelText('Pool name')
  },
  getTableToggle(label: string) {
    return container.getByRole('button', { name: label, pressed: false })
  },
  getSelectedTableToggle(label: string) {
    return container.getByRole('button', { name: label, pressed: true })
  },
  getRemoveButton() {
    return container.getByRole('button', { name: 'Remove pool' })
  },
})

/** Test page-object for `PoolCard`. */
export const poolCardPage = {
  render(overrides: Partial<PoolCardProps> = {}) {
    render(<PoolCard {...buildPoolCardProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
