import { render, screen, type Container } from '@/test/utilities'

import { LifecycleActions, type LifecycleActionsProps } from './lifecycle-actions'
import { buildLifecycleActionsProps } from './lifecycle-actions.factory'

const scoped = (container: Container) => ({
  /** The one lifecycle button on offer — there is never more than one, because
   * a status has at most one legal edge out of it (ADR-0017). */
  getLifecycleButton(name: RegExp) {
    return container.getByRole('button', { name })
  },
  queryLifecycleButton(name: RegExp) {
    return container.queryByRole('button', { name })
  },
  /** Every button the component renders — `[]` for a non-owner and for the
   * terminal `archived`. */
  queryAllButtons() {
    return container.queryAllByRole('button')
  },
})

/** Test page-object for `LifecycleActions`. */
export const lifecycleActionsPage = {
  render(overrides: Partial<LifecycleActionsProps> = {}) {
    render(<LifecycleActions {...buildLifecycleActionsProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
