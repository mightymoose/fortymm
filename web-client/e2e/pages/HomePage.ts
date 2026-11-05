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

  // The sidebar, a tab bar below 900px, and the page's own New match link.
  readonly nav: Locator
  readonly pageNewMatchLink: Locator

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
    this.nav = page.getByRole('navigation', { name: 'Main' })
    this.pageNewMatchLink = page.getByRole('main').getByRole('link', { name: 'New match' })
  }

  // Opens the account menu and picks `item`, such as Sign in. A verified
  // account's Sign out leaves at once. A guest's opens a dialog first.
  async fromAccountMenu(item: 'Sign in' | 'Sign out'): Promise<void> {
    await this.accountButton.click()
    await this.accountMenu.getByRole('menuitem', { name: item }).click()
  }

  // The sidebar's link named `name`, such as Matches.
  navLink(name: string): Locator {
    return this.nav.getByRole('link', { name })
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

  // Waits for the app to register the browser's signing key, which it does
  // after the session starts. Call it before the load that starts one.
  async keyRegistered(): Promise<void> {
    const response = await this.page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/account/signing-keys') &&
        response.request().method() === 'POST',
    )
    if (!response.ok()) throw new Error(`The key's registration answered ${response.status()}`)
  }

  // The id of the signing key in the browser's IndexedDB, in hex, or null.
  // A string, because the e2e suite's types have no DOM.
  storedKeyId(): Promise<string | null> {
    return this.page.evaluate(`new Promise((resolve, reject) => {
      const opened = indexedDB.open('fortymm-signing', 1)
      opened.onupgradeneeded = () => opened.result.createObjectStore('device-key')
      opened.onerror = () => reject(opened.error)
      opened.onsuccess = () => {
        const read = opened.result.transaction('device-key').objectStore('device-key').get('device')
        read.onerror = () => reject(read.error)
        read.onsuccess = () => {
          opened.result.close()
          const kid = read.result?.kid
          resolve(kid ? Array.from(kid, (b) => b.toString(16).padStart(2, '0')).join('') : null)
        }
      }
    })`)
  }
}
