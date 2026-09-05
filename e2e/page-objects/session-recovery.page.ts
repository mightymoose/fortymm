import { type Page } from '@playwright/test'

export class SessionRecoveryPage {
  constructor(readonly page: Page) {}
  get signedOutNotice() { return this.page.getByRole('alert').filter({ hasText: "You've been signed out" }) }
  get userMenu() { return this.page.getByTestId('user-menu') }
  get logout() { return this.page.getByTestId('user-menu-logout') }
  get newGuest() { return this.page.getByRole('button', { name: 'Continue as a new guest' }) }
  get cancelSwitch() { return this.page.getByRole('button', { name: 'Cancel', exact: true }) }
  switchHeading(username: string) { return this.page.getByRole('heading', { name: `Continue as ${username}?` }) }
  continueAs(username: string) { return this.page.getByRole('button', { name: `Continue as ${username}`, exact: true }) }
  get linkCheck() { return this.page.getByTestId('link-check-page') }
  get dashboardLink() { return this.page.getByRole('link', { name: 'Go to dashboard' }) }
}
