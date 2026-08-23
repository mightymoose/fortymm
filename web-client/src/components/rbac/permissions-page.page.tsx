import userEvent from '@testing-library/user-event'
import { render, screen, within as rtlWithin, type Container } from '@/test/utilities'
import { server } from '@/mocks/server'
import { rbacHandlersFor } from '@/mocks/handlers'
import { createRbacState, type RbacState, type SeedSpec } from '@/mocks/rbac-engine'
import { PermissionsPage } from './permissions-page'
import { buildPermissionsSeed } from './permissions-page.factory'

const scoped = (container: Container) => ({
  /** The list's search box. It carries a placeholder rather than a label. */
  findSearch() {
    return container.findByPlaceholderText('Search by name or description')
  },
  /** A permission's row in the grouped table. */
  findPermissionRow(name: string) {
    return container.findByTestId(`perm-row-${name}`)
  },
  queryPermissionRow(name: string) {
    return container.queryByTestId(`perm-row-${name}`)
  },
  /** Every permission row currently rendered, across every open group. */
  queryPermissionRows() {
    return container.queryAllByTestId(/^perm-row-/)
  },
  /** The panel shown when the search matches nothing. */
  queryNoMatches() {
    return container.queryByText('No permissions match.')
  },
})

/**
 * Test page-object for the admin `PermissionsPage`. It seeds a caller-owned
 * RBAC state and points MSW at it, so the page reads through the same mock
 * engine the roles and users quartets use.
 */
export const permissionsPage = {
  render(seed: SeedSpec = buildPermissionsSeed()): RbacState {
    const state = createRbacState(seed)
    server.use(...rbacHandlersFor(state))
    render(<PermissionsPage />)
    return state
  },

  user() {
    return userEvent.setup()
  },

  /** Type `text` into the search box, once it has painted. */
  async search(text: string) {
    const box = await this.findSearch()
    await userEvent.type(box, text)
    return box
  },

  within(node?: HTMLElement) {
    return scoped(node ? rtlWithin(node) : screen)
  },

  ...scoped(screen),
}
