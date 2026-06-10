import { render, screen, type Container } from '@/test/utilities'
import { SaveFlash, type SaveFlashProps } from './save-flash'
import { buildSaveFlashProps } from './save-flash.factory'

const scoped = (container: Container) => ({
  /** The banner itself (role="alert"). */
  getFlash() {
    return container.getByRole('alert')
  },
  queryFlash() {
    return container.queryByRole('alert')
  },
  /** The ✕ dismiss button. */
  getDismissButton() {
    return container.getByRole('button', { name: 'Dismiss' })
  },
})

/** Test page-object for `SaveFlash`. Synchronous render, no router or MSW —
 * tests can query immediately after `render`. */
export const saveFlashPage = {
  render(overrides: Partial<SaveFlashProps> = {}) {
    const props = buildSaveFlashProps(overrides)
    render(<SaveFlash {...props} />)
  },

  /**
   * Scope the accessors to a container — the whole `screen` (default) or a
   * `within(node)` subtree. Page objects that embed this component spread
   * this to expose the same queries as their own.
   */
  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
