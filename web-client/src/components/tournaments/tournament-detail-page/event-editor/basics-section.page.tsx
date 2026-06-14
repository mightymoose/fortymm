import { render, screen, type Container } from '@/test/utilities'

import { BasicsSection, type BasicsSectionProps } from './basics-section'
import { buildBasicsSectionProps } from './basics-section.factory'

const scoped = (container: Container) => ({
  getNameInput() {
    return container.getByLabelText(/Event name/)
  },
  getPlayerLimitInput() {
    return container.getByLabelText(/Player limit/)
  },
  getFormatTrigger() {
    return container.getByRole('combobox', { name: 'Format' })
  },
})

/** Test page-object for `BasicsSection`. */
export const basicsSectionPage = {
  render(overrides: Partial<BasicsSectionProps> = {}) {
    render(<BasicsSection {...buildBasicsSectionProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
