import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.ts'

// The migration makes this email's account an administrator, which holds
// `matches.view`.
const administrator = { sub: 'e2e|mightymoose', email: 'mightymoose@fortymm.com' }

// How far the page scrolls sideways: 0 when everything fits.
const sideways = (page: Page) =>
  page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')

// A phone, just above the 900px breakpoint where the sidebar is tightest,
// and a laptop.
for (const width of [390, 920, 1280]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } })

    test('the Matches page and a match fit without scrolling sideways', async ({ page, signInPage }) => {
      await signInPage.signIn(administrator, { returnTo: '/' })
      await page.goto('/matches')

      const match = page.getByRole('link', { name: 'Thanh Nguyen vs Rashid Ali' })
      await expect(match).toBeVisible()
      await expect(page.getByRole('table')).toHaveCount(width < 900 ? 0 : 1)
      expect(await sideways(page)).toBe(0)

      await match.click()
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thanh Nguyen vs Rashid Ali')
      expect(await sideways(page)).toBe(0)
    })
  })
}
