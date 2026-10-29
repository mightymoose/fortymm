import type { Locator, Page } from '@playwright/test'

// Page object for the home page in the Playwright suite.
export class HomePage {
  readonly page: Page
  readonly title: Locator
  // The loading screen the app shows in place of the page on a full page
  // load, until the session starts.
  readonly loadingScreen: Locator
  // The topbar's chip that opens the account menu, the menu, and the dialog
  // that asks a guest before it signs out.
  readonly accountButton: Locator
  readonly accountMenu: Locator
  readonly guestSignOutDialog: Locator

  // The reminder of the players still to review, by its title.
  readonly reminder: Locator

  constructor(page: Page) {
    this.page = page
    this.title = page.getByRole('heading', { level: 1 })
    this.loadingScreen = page.getByRole('status', { name: 'Loading FortyMM' })
    this.accountButton = page.getByRole('button', { name: 'Your account' })
    this.accountMenu = page.getByRole('menu', { name: 'Your account' })
    this.guestSignOutDialog = page.getByRole('dialog', {
      name: 'Sign out of this guest account?',
    })
    this.reminder = page.getByText(/^\d+ players? to review$/)
  }

  // Opens the account menu and picks `item`, such as Sign in. A verified
  // account's Sign out leaves at once. A guest's opens a dialog first.
  async fromAccountMenu(item: 'Sign in' | 'Sign out'): Promise<void> {
    await this.accountButton.click()
    await this.accountMenu.getByRole('menuitem', { name: item }).click()
  }

  // The topbar's avatar of the player named `displayName`.
  avatar(displayName: string): Locator {
    return this.page.getByRole('img', { name: displayName })
  }

  // Opens the page and waits for the loading screen over it to go.
  async goto(): Promise<void> {
    await this.open()
    await this.title.waitFor()
    await this.loadingScreen.waitFor({ state: 'hidden' })
  }

  // Opens the page without waiting for the loading screen to go.
  async open(): Promise<void> {
    await this.page.goto('/')
  }
}
