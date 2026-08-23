import userEvent from '@testing-library/user-event'
import { render, screen, within as rtlWithin, type Container } from '@/test/utilities'
import { server } from '@/mocks/server'
import { rbacHandlersFor } from '@/mocks/handlers'
import { createRbacState, type RbacState, type SeedSpec } from '@/mocks/rbac-engine'
import { RolesPage } from './roles-page'
import { buildRolesSeed } from './roles-page.factory'

const scoped = (container: Container) => ({
  /** The list's search box. It carries a placeholder rather than a label. */
  findSearch() {
    return container.findByPlaceholderText('Search roles')
  },
  /** Every role row currently rendered. */
  queryRoleRows() {
    return container.queryAllByTestId(/^role-row-/)
  },
  /** A role's row in the left-hand list. */
  findRoleRow(name: string) {
    return container.findByTestId(`role-row-${name}`)
  },
  queryRoleRow(name: string) {
    return container.queryByTestId(`role-row-${name}`)
  },
  /** The detail panel for whichever role is currently selected. */
  findDetail() {
    return container.findByTestId('role-detail')
  },
  /** The Delete control in the detail header. */
  findDeleteButton() {
    return container.findByRole('button', { name: /delete/i })
  },
  findEditButton() {
    return container.findByRole('button', { name: /^edit$/i })
  },
  /** The edit modal's Name input — disabled for the default role. Its absence
   * is how a test knows the modal closed (it closes only on success). */
  findNameInput() {
    return container.findByLabelText('Name')
  },
  queryNameInput() {
    return container.queryByLabelText('Name')
  },
  findDescriptionInput() {
    return container.findByLabelText('Description')
  },
  findSaveButton() {
    return container.findByRole('button', { name: /save changes/i })
  },
  /** The "New role" button that opens the create modal. */
  findNewRoleButton() {
    return container.findByRole('button', { name: /new role/i })
  },
  /** The create modal's submit button. */
  findCreateButton() {
    return container.findByRole('button', { name: /create role/i })
  },
  /** The checkbox that grants `permName` to the selected role. */
  findPermToggle(permName: string) {
    return container.findByTestId(`perm-toggle-${permName}`)
  },
  queryDefaultBadge() {
    return container.queryByText('Default')
  },
  /** Anything carrying `text` as a native tooltip (`title`). */
  queryTooltip(text: string | RegExp) {
    return container.queryByTitle(text)
  },
})

/**
 * Test page-object for the admin `RolesPage`. It seeds a caller-owned RBAC
 * state (defaulting to one default + one plain role) and points MSW at it, so
 * the page reads and writes through the same mock engine the e2e suite uses —
 * a PATCH or DELETE the API would refuse is refused here too.
 */
export const rolesPage = {
  /** Seed MSW, render, and hand back the live mock state so a test can assert
   * on what the page actually persisted. */
  render(seed: SeedSpec = buildRolesSeed()): RbacState {
    const state = createRbacState(seed)
    server.use(...rbacHandlersFor(state))
    render(<RolesPage />)
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

  /** Select a role in the sidebar and resolve its detail panel. */
  async select(name: string) {
    const row = await this.findRoleRow(name)
    await userEvent.click(row)
    const detail = await this.findDetail()
    await rtlWithin(detail).findByRole('heading', { level: 1, name })
    return detail
  },

  /** Scope every accessor to a subtree — e.g. one sidebar row, or the detail
   * panel — so "the default badge" means *that* role's badge. */
  within(node?: HTMLElement) {
    return scoped(node ? rtlWithin(node) : screen)
  },

  ...scoped(screen),
}
