import { screen, within, type Container } from '@/test/utilities'
import { renderWithRoutes } from '@/test/router'
import { StatusRow, type StatusRowProps } from './status-row'
import { buildStatusRowProps } from './status-row.factory'

const scoped = (container: Container) => ({
  /** The status region — present in every state. */
  findStatus() {
    return container.findByRole('region', { name: 'Connection status' })
  },
  /** The status pill's label, e.g. `READY TO CONNECT`. Absent when that state
   * isn't the one rendered, which is how "only its own row" is asserted. */
  queryPill(label: string) {
    return container.queryByText(label)
  },
  /** The one line of copy under the pill, matched on a distinctive fragment. */
  queryCopy(fragment: string | RegExp) {
    return container.queryByText(fragment)
  },
  /**
   * The same, scoped to the status region.
   *
   * On the whole page the ready row's email is *also* printed by the setup
   * panel below it, so an unscoped `queryCopy` for it matches twice and throws.
   * Use this whenever the assertion is about what the **row** says.
   */
  queryStatusCopy(fragment: string | RegExp) {
    const status = container.getByRole('region', { name: 'Connection status' })
    return within(status).queryByText(fragment)
  },
  /** The row's single action, by its visible label. */
  queryAction(label: string) {
    return container.queryByRole('link', { name: label })
  },
  /**
   * The value of a labelled field in the connected card (`Signed in as`,
   * `Connected`). Read as the `<dd>` following the `<dt>` so no test-only
   * markup exists to hold it.
   */
  getFieldValue(label: string) {
    const term = container.getByText(label)
    const value = term.nextElementSibling
    if (!value) throw new Error(`No value follows the "${label}" label.`)
    return value
  },
})

/**
 * Test page-object for `StatusRow`.
 *
 * The guest row renders a typed `<Link>`, so every render goes through the
 * memory-router harness and tests must start with `await findStatus()`.
 */
export const statusRowPage = {
  render(overrides: Partial<StatusRowProps> = {}) {
    const props = buildStatusRowProps(overrides)
    renderWithRoutes(<StatusRow {...props} />, { linkTargets: ['/settings'] })
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
