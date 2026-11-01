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

  // The app shell's link to the iPhone beta. It shows only below 600px.
  readonly iphoneAppLink: Locator
  // The topbar's button that folds the sidebar to its icons, from 900px up.
  readonly sidebarLabelsButton: Locator

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
    this.iphoneAppLink = page.getByRole('link', { name: 'Get the iPhone app' })
    this.sidebarLabelsButton = page.getByRole('button', { name: 'Sidebar labels' })
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

  // Opens the page and waits for it to replace the loading screen.
  async goto(): Promise<void> {
    await this.open()
    await this.title.waitFor()
  }

  // Opens the page without waiting for the loading screen to go.
  async open(): Promise<void> {
    await this.page.goto('/')
  }
}
