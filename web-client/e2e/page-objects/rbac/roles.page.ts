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
  /** Role row in the left sidebar */
  roleRow(name: string): Locator {
    return this.page.locator('.rbac-row').filter({ hasText: name }).first()
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
