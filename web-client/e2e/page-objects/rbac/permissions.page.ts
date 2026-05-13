import type { Locator, Page } from '@playwright/test'
import { RbacPage, openRbacPage } from './rbac.page'
import type { SeedSpec } from './rbac-store'

export class PermissionsPage extends RbacPage {
  static navigateTo(page: Page, seed: SeedSpec = {}) {
    return openRbacPage(PermissionsPage, page, '/admin/permissions', seed)
  }

  get heading(): Locator {
    return this.page.getByRole('heading', { name: 'Permissions', level: 1 })
  }
  get newButton(): Locator {
    return this.page.getByRole('button', { name: /New permission/i })
  }
  get searchInput(): Locator {
    return this.page.getByPlaceholder('Search by name or description')
  }
  get emptyState(): Locator {
    return this.page.getByText('No permissions yet')
  }
  permissionRow(name: string): Locator {
    return this.page
      .locator('.rbac-row')
      .filter({ has: this.page.getByText(name, { exact: true }) })
      .first()
  }
  get confirmDeleteButton(): Locator {
    return this.page.getByRole('button', { name: 'Delete permission' })
  }
  get dialogNameInput(): Locator {
    return this.page.getByPlaceholder('tournament.publish')
  }
  get dialogDescriptionInput(): Locator {
    return this.page.getByPlaceholder(/Publish a tournament/i)
  }
  get dialogCreateButton(): Locator {
    return this.page.getByRole('button', { name: 'Create permission' })
  }
  get dialogSaveButton(): Locator {
    return this.page.getByRole('button', { name: 'Save changes' })
  }
}
