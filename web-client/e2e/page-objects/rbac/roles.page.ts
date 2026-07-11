import type { Locator, Page } from '@playwright/test'
import { RbacPage, openRbacPage } from './rbac.page'
import type { SeedSpec } from './rbac-store'

export class RolesPage extends RbacPage {
  static navigateTo(page: Page, seed: SeedSpec = {}) {
    return openRbacPage(RolesPage, page, '/admin/roles', seed)
  }

  get heading(): Locator {
    return this.page.getByText('Roles', { exact: true }).first()
  }
  get newButton(): Locator {
    return this.page.getByRole('button', { name: /New role/i })
  }
  get duplicateButton(): Locator {
    return this.page.getByRole('button', { name: /Duplicate/i })
  }
  get deleteButton(): Locator {
    return this.page.getByRole('button', { name: 'Delete', exact: false }).first()
  }
  get searchInput(): Locator {
    return this.page.getByPlaceholder('Search roles')
  }
  get emptyState(): Locator {
    return this.page.getByText('No roles yet')
  }
  /** Role row in the left sidebar. Keyed by test id, not by text: every row
   * carries a "N users" count, and `hasText` is a case-insensitive substring —
   * so filtering for a role literally named `User` would match every row. */
  roleRow(name: string): Locator {
    return this.page.getByTestId(`role-row-${name}`)
  }
  /** Permission row in the editor (matches by perm name) */
  permRow(name: string): Locator {
    return this.page
      .locator('.rbac-row')
      .filter({ has: this.page.getByText(name, { exact: true }) })
      .first()
  }
  /** Detail title (h1 with role name) */
  detailTitle(name: string): Locator {
    // Inline rename was replaced by a modal Edit dialog; the h1 is now plain.
    return this.page.getByRole('heading', { level: 1, name }).first()
  }
  get editButton(): Locator {
    return this.page.getByRole('button', { name: /^Edit$/ }).first()
  }
  get editNameInput(): Locator {
    return this.page.getByLabel('Name', { exact: true })
  }
  get editSaveButton(): Locator {
    return this.page.getByRole('button', { name: 'Save changes' })
  }
  get confirmDeleteButton(): Locator {
    return this.page.getByRole('button', { name: 'Delete role' })
  }
  /** The "Default" badge inside a role's sidebar row — absent on a normal role. */
  roleRowBadge(name: string): Locator {
    return this.page.getByTestId(`role-row-${name}`).getByText('Default', { exact: true })
  }
  /** The "Default" badge in the detail header of the selected role. */
  get detailBadge(): Locator {
    return this.page.getByTestId('role-detail').getByText('Default', { exact: true })
  }
  /** The span wrapping the Delete button — it carries the "why not" tooltip,
   * since a disabled button is pointer-events-none and would never show one. */
  get deleteTooltipHost(): Locator {
    return this.page.getByTestId('delete-role-tooltip')
  }
  /** The checkbox that grants `permName` to the selected role. */
  permToggle(permName: string): Locator {
    return this.page.getByTestId(`perm-toggle-${permName}`)
  }
  get newRoleNameInput(): Locator {
    return this.page.getByPlaceholder(/Volunteer scorer/i)
  }
  get newRoleDescriptionInput(): Locator {
    return this.page.getByPlaceholder(/What can people with this role do/i)
  }
  get newRoleSubmit(): Locator {
    return this.page.getByRole('button', { name: 'Create role' })
  }
}
