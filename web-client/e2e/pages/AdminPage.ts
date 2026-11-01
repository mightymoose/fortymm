import type { Locator, Page } from '@playwright/test'

// Page object for the admin page. Only the open tab's panel shows.
export class AdminPage {
  readonly page: Page
  readonly title: Locator
  readonly panel: Locator

  constructor(page: Page) {
    this.page = page
    this.title = page.getByRole('heading', { level: 1, name: 'Admin' })
    this.panel = page.getByRole('tabpanel')
  }

  async goto(): Promise<void> {
    await this.page.goto('/admin')
  }

  // The open tab's table row whose first cell starts with `name`.
  row(name: string): Locator {
    return this.panel.getByRole('row', { name: new RegExp(`^${escape(name)}`) })
  }

  // Creates the role `name` with `permissions`, on the Roles tab.
  async createRole(name: string, permissions: readonly string[]): Promise<void> {
    await this.panel.getByRole('button', { name: 'New role' }).click()
    const sheet = this.page.getByRole('dialog', { name: 'New role' })
    await sheet.getByRole('textbox', { name: 'Name' }).fill(name)
    for (const key of permissions) {
      await sheet.getByRole('checkbox', { name: new RegExp(`^${escape(key)}`) }).check()
    }
    await sheet.getByRole('button', { name: 'Create role' }).click()
    await sheet.waitFor({ state: 'hidden' })
  }

  // Deletes the role `name`, through its dialog.
  async deleteRole(name: string): Promise<void> {
    await this.panel.getByRole('button', { name: `Delete ${name}` }).click()
    const dialog = this.page.getByRole('dialog', { name: `Delete ${name}?` })
    await dialog.getByRole('button', { name: 'Delete role' }).click()
    await dialog.waitFor({ state: 'hidden' })
  }
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
