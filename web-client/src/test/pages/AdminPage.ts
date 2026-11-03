import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderRoute, type AppRouter } from '../renderRoute'

export type AdminTab = 'Roles' | 'Permissions' | 'Accounts' | 'Signing keys'

// Page object for the admin page and an account's admin page in unit tests.
// Mock the admin routes with mockAdmin() from ../server first. Only the
// selected tab's panel is visible, so open a tab before reading it.
export class AdminPage {
  static async render(path = '/admin'): Promise<AdminPage> {
    return new AdminPage(await renderRoute(path))
  }

  static renderAccount(id: string): Promise<AdminPage> {
    return AdminPage.render(`/admin/accounts/${id}`)
  }

  readonly router: AppRouter
  readonly user = userEvent.setup()

  constructor(router: AppRouter) {
    this.router = router
  }

  // The router's current path and query, such as `/admin`.
  get href(): string {
    return this.router.state.location.href
  }

  get title(): HTMLElement | null {
    return screen.queryByRole('heading', { level: 1, name: 'Administration' })
  }

  // Opens the account menu, and returns its link to the admin page, or null.
  async adminLink(): Promise<HTMLElement | null> {
    await this.user.click(screen.getByRole('button', { name: 'Your account' }))
    const menu = screen.getByRole('menu', { name: 'Your account' })
    return within(menu).queryByRole('menuitem', { name: 'Administration' })
  }

  get selectedTab(): string | null {
    return screen.queryByRole('tab', { selected: true })?.textContent ?? null
  }

  // A link in the panel or, on an account's page, in its breadcrumb.
  async follow(name: string): Promise<void> {
    await this.user.click(screen.getByRole('link', { name }))
  }

  // An account's page: its heading, once it loads.
  findHeading(name: string): Promise<HTMLElement> {
    return screen.findByRole('heading', { level: 1, name })
  }

  // An account's page: its Roles card.
  get rolesCard(): HTMLElement {
    return screen.getByRole('region', { name: 'Roles' })
  }

  async openTab(tab: AdminTab): Promise<void> {
    await this.user.click(screen.getByRole('tab', { name: tab }))
  }

  // The selected tab's panel.
  get panel(): HTMLElement {
    return screen.getByRole('tabpanel')
  }

  // Whether the panel shows its skeleton, such as "Loading roles".
  loading(label: string): boolean {
    return within(this.panel).queryByText(label) !== null
  }

  // The panel's load error, or null.
  get loadError(): HTMLElement | null {
    return within(this.panel).queryByRole('alert')
  }

  async tryAgain(): Promise<void> {
    await this.user.click(within(this.loadError!).getByRole('button', { name: 'Try again' }))
  }

  // The panel's table rows, each as its cells' text.
  get rows(): string[][] {
    return within(this.panel)
      .queryAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent ?? ''))
  }

  // Waits for a row whose first cell starts with `name`.
  findRow(name: string): Promise<HTMLElement> {
    return within(this.panel).findByRole('row', { name: new RegExp(`^${escape(name)}`) })
  }

  // A button in the panel, such as "New role" or "Delete games.record", or
  // null.
  button(name: string): HTMLElement | null {
    return within(this.panel).queryByRole('button', { name })
  }

  async click(name: string): Promise<void> {
    await this.user.click(within(this.panel).getByRole('button', { name }))
  }

  // The open drawer or dialog, by its title, or null.
  dialog(name: string): HTMLElement | null {
    return screen.queryByRole('dialog', { name })
  }

  // The text field in `container` whose label starts with `label`, such as
  // "Description" for "Description (optional)".
  field(container: HTMLElement, label: string): HTMLElement {
    const search = label === 'Email' || label === 'Account'
    return within(container).getByRole(search ? 'searchbox' : 'textbox', {
      name: new RegExp(`^${escape(label)}`),
    })
  }

  async type(container: HTMLElement, label: string, text: string): Promise<void> {
    const field = this.field(container, label)
    await this.user.clear(field)
    if (text) await this.user.type(field, text)
  }

  // Ticks or unticks the checkbox whose label starts with `name`.
  async toggle(dialog: HTMLElement, name: string): Promise<void> {
    await this.user.click(
      within(dialog).getByRole('checkbox', { name: new RegExp(`^${escape(name)}`) }),
    )
  }

  async press(dialog: HTMLElement, name: string): Promise<void> {
    await this.user.click(within(dialog).getByRole('button', { name }))
  }

  // Searches the accounts by email.
  async search(email: string): Promise<void> {
    await this.type(this.panel, 'Email', email)
    await this.click('Search')
  }

  // Searches the signing keys by account.
  async searchKeys(text: string): Promise<void> {
    await this.type(this.panel, 'Account', text)
    await this.click('Search')
  }

  findToast(message: string): Promise<HTMLElement> {
    return screen.findByText(message)
  }
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
