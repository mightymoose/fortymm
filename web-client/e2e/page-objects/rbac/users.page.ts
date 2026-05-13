import type { Locator, Page } from '@playwright/test'
import { RbacPage, openRbacPage } from './rbac.page'
import type { SeedSpec } from './rbac-store'

export class UsersPage extends RbacPage {
  static navigateTo(page: Page, seed: SeedSpec = {}) {
    return openRbacPage(UsersPage, page, '/admin/users', seed)
  }

  get heading(): Locator {
    return this.page.getByRole('heading', { name: 'Users', level: 1 })
  }
  get addButton(): Locator {
    return this.page.getByRole('button', { name: /Add user/i })
  }
  get searchInput(): Locator {
    return this.page.getByPlaceholder('Search by username')
  }
  get emptyState(): Locator {
    return this.page.getByText('No users yet')
  }
  userRow(username: string): Locator {
    return this.page.locator('.rbac-row').filter({ hasText: username }).first()
  }
  get sheet(): Locator {
    return this.page.locator('[data-slot=sheet-content]')
  }
  drawerRoleRow(name: string): Locator {
    return this.sheet.locator('.rbac-row').filter({ hasText: name }).first()
  }
  get saveButton(): Locator {
    return this.sheet.getByRole('button', { name: /Save changes/i })
  }
  get noChangesButton(): Locator {
    return this.sheet.getByRole('button', { name: 'No changes' })
  }
  get removeButton(): Locator {
    return this.sheet.getByRole('button', { name: /Remove user/i })
  }
  get confirmRemoveButton(): Locator {
    return this.page.getByRole('button', { name: 'Remove user' }).last()
  }
  get newUsernameInput(): Locator {
    return this.page.getByPlaceholder(/jamie\.tran/i)
  }
  get newUserSubmit(): Locator {
    return this.page.getByRole('button', { name: 'Add user' }).last()
  }
}
