import { test as base } from '@playwright/test'
import { AdminPage } from './pages/AdminPage.ts'
import { DesignSystemPage } from './pages/DesignSystemPage.ts'
import { DeviceStorage } from './pages/DeviceStorage.ts'
import { HomePage } from './pages/HomePage.ts'
import { ReferenceKitPage } from './pages/ReferenceKitPage.ts'
import { SignInPage } from './pages/SignInPage.ts'
import { SignedOutPage } from './pages/SignedOutPage.ts'

// Specs import `test` and `expect` from here to receive page objects as
// fixtures, e.g. `test('...', async ({ homePage }) => { ... })`.
export const test = base.extend<{
  adminPage: AdminPage
  designSystemPage: DesignSystemPage
  deviceStorage: DeviceStorage
  homePage: HomePage
  referenceKitPage: ReferenceKitPage
  signInPage: SignInPage
  signedOutPage: SignedOutPage
}>({
  // The callbacks are named `provide`, not Playwright's usual `use`, so the
  // React hooks lint rule doesn't mistake them for hooks.
  adminPage: async ({ page }, provide) => {
    await provide(new AdminPage(page))
  },
  designSystemPage: async ({ page }, provide) => {
    await provide(new DesignSystemPage(page))
  },
  deviceStorage: async ({ page }, provide) => {
    await provide(new DeviceStorage(page))
  },
  homePage: async ({ page }, provide) => {
    await provide(new HomePage(page))
  },
  referenceKitPage: async ({ page }, provide) => {
    await provide(new ReferenceKitPage(page))
  },
  signInPage: async ({ page }, provide) => {
    await provide(new SignInPage(page))
  },
  signedOutPage: async ({ page }, provide) => {
    await provide(new SignedOutPage(page))
  },
})

export { expect } from '@playwright/test'
