import userEvent from '@testing-library/user-event'
import { render, screen, within as rtlWithin, type Container } from '@/test/utilities'
import { server } from '@/mocks/server'
import { rbacHandlersFor } from '@/mocks/handlers'
import { createRbacState, type RbacState, type SeedSpec } from '@/mocks/rbac-engine'
import { UsersPage } from './users-page'
import { buildUsersSeed } from './users-page.factory'

const scoped = (container: Container) => ({
  /** The list's search box. It carries a placeholder rather than a label. */
  findSearch() {
    return container.findByPlaceholderText('Search by username')
  },
  /** Every user row currently rendered. */
  queryUserRows() {
    return container.queryAllByTestId(/^user-row-/)
  },
  /** The header action that opens the add-user modal. */
  findAddUserButton() {
    return container.findByRole('button', { name: /add user/i })
  },
  /** The add-user modal's Username field. `Field` renders its label in a plain
   * `div`, not a `<label>`, so there is nothing for `findByLabelText` to bind. */
  findNewUsernameInput() {
    return container.findByPlaceholderText('e.g. jamie.tran')
  },
  /** The hint under the modal's Username field — the form's stated rule. */
  queryHint(text: string | RegExp) {
    return container.queryByText(text)
  },
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
  /** The "Remove user" button in the open drawer's footer. */
  findRemoveButton() {
    return container.findByRole('button', { name: /remove user/i })
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

  /** Type `text` into the search box, once it has painted. */
  async search(text: string) {
    const box = await this.findSearch()
    await userEvent.type(box, text)
    return box
  },

  /** Open the add-user modal and type `username` into it. Resolves the modal's
   * own submit button, whose disabled state is the form's verdict. */
  async typeNewUsername(username: string) {
    await userEvent.click(await this.findAddUserButton())
    const input = await this.findNewUsernameInput()
    await userEvent.clear(input)
    if (username) await userEvent.type(input, username)
    const buttons = await screen.findAllByRole('button', { name: /^add user$/i })
    // The header action and the modal's submit share a name; the modal's is last.
    return buttons[buttons.length - 1]
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
