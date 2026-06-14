import { render, screen, type Container } from '@/test/utilities'

import { DetailsTab, type DetailsTabProps } from './details-tab'
import { buildDetailsTabProps } from './details-tab.factory'

const scoped = (container: Container) => ({
  getNameInput() {
    return container.getByLabelText(/Name/)
  },
  querySaveButton() {
    return container.queryByRole('button', { name: /Save changes/ })
  },
})

/** Test page-object for `DetailsTab`. */
export const detailsTabPage = {
  render(overrides: Partial<DetailsTabProps> = {}) {
    render(<DetailsTab {...buildDetailsTabProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
