import userEvent from '@testing-library/user-event'
import { render, screen, within as rtlWithin, type Container } from '@/test/utilities'
import { server } from '@/mocks/server'
import { rbacHandlersFor } from '@/mocks/handlers'
import { createRbacState, type RbacState, type SeedSpec } from '@/mocks/rbac-engine'
import { UsersPage } from './users-page'
import { buildUsersSeed } from './users-page.factory'

const scoped = (container: Container) => ({
  /** A user's row in the table. */
  findUserRow(username: string) {
    return container.findByTestId(`user-row-${username}`)
  },
  /** The role-assignment checkbox for `roleName` in the open drawer. Named via
   * the checkbox's `aria-label`, so it's the role's *own* control, not the
   * "select all" or a permission toggle. */
  findRoleCheckbox(roleName: string) {
    return container.findByRole('checkbox', { name: roleName })
  },
  /** The Save button in the drawer footer (labelled "Save changes" when dirty,
   * "No changes" otherwise). */
  findSaveButton() {
    return container.findByRole('button', { name: /save changes/i })
  },
  queryNoChangesButton() {
    return container.queryByRole('button', { name: /no changes/i })
  },
  /** Anything carrying `text` as a native tooltip (`title`) — the wrapper span
   * around a disabled checkbox, mirroring the delete-role-tooltip host. */
  queryTooltip(text: string | RegExp) {
    return container.queryByTitle(text)
  },
})

/**
 * Test page-object for the admin `UsersPage`. It seeds a caller-owned RBAC
 * state (defaulting to one default role + one plain one, and a user holding
 * only the default) and points MSW at it, so the page reads and writes through
 * the same mock engine the e2e suite uses — a PUT the API would rewrite is
 * rewritten here too.
 *
 * The role editor lives in a `Sheet`, which portals to `document.body`, so all
 * accessors bind to `screen` rather than the render container.
 */
export const usersPage = {
  render(seed: SeedSpec = buildUsersSeed()): RbacState {
    const state = createRbacState(seed)
    server.use(...rbacHandlersFor(state))
    render(<UsersPage />)
    return state
  },

  user() {
    return userEvent.setup()
  },

  /** Click a user's row and resolve the open role-editor drawer. */
  async open(username: string) {
    const row = await this.findUserRow(username)
    await userEvent.click(row)
    // The sr-only heading inside the drawer confirms it mounted for this user.
    await screen.findByRole('heading', { name: `User ${username}` })
  },

  within(node?: HTMLElement) {
    return scoped(node ? rtlWithin(node) : screen)
  },

  ...scoped(screen),
}
