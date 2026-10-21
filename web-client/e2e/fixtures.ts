import { test as base } from '@playwright/test'
import { HomePage } from './pages/HomePage.ts'

// Specs import `test` and `expect` from here to receive page objects as
// fixtures, e.g. `test('...', async ({ homePage }) => { ... })`.
export const test = base.extend<{ homePage: HomePage }>({
  // The callback is named `provide`, not Playwright's usual `use`, so the
  // React hooks lint rule doesn't mistake it for a hook.
  homePage: async ({ page }, provide) => {
    await provide(new HomePage(page))
  },
})

export { expect } from '@playwright/test'
