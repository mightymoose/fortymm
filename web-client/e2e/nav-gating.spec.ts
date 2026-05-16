/**
 * Verifies the side-nav adapts to the current session's permissions:
 *
 *   - Administration entry hides entirely unless `administration.view`.
 *   - Roles / Permissions / Users children show only with `authorization.manage`.
 *   - When the only surviving child is "Overview", Administration renders as
 *     a flat link with no sub-menu (matching the other top-level items).
 */
import { test, expect, type Page } from '@playwright/test'

interface SessionShape {
  username?: string
  permissions: string[]
}

async function withSession(page: Page, session: SessionShape) {
  await page.route('**/v1/session', async (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          user: {
            username: session.username ?? 'tester',
            permissions: session.permissions,
          },
        },
      }),
    }),
  )
  // Generic catch-all so the dashboard (or any other AppShell page) doesn't
  // surface unrelated 404s from missing API mocks.
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/v1/session')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            user: {
              username: session.username ?? 'tester',
              permissions: session.permissions,
            },
          },
        }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    })
  })
}

function sidebar(page: Page) {
  return page.locator('.app-shell__sidebar')
}

test.describe('Sidebar permission gating', () => {
  test('hides Administration when user has neither admin permission', async ({ page }) => {
    await withSession(page, { permissions: [] })
    await page.goto('/dashboard')

    const bar = sidebar(page)
    await expect(bar.getByRole('link', { name: /Dashboard/i })).toBeVisible()
    await expect(bar.getByRole('link', { name: /Administration/i })).toHaveCount(0)
    await expect(bar.getByRole('link', { name: /^Roles$/ })).toHaveCount(0)
    await expect(bar.getByRole('link', { name: /^Permissions$/ })).toHaveCount(0)
    await expect(bar.getByRole('link', { name: /^Users$/ })).toHaveCount(0)
  })

  test('administration.view alone shows Administration as a flat link with no children', async ({ page }) => {
    await withSession(page, { permissions: ['administration.view'] })
    await page.goto('/dashboard')

    const bar = sidebar(page)
    await expect(bar.getByRole('link', { name: /Administration/i })).toBeVisible()
    // No sub-nav children should render.
    await expect(bar.locator('.app-shell__sub-nav-list')).toHaveCount(0)
    await expect(bar.getByRole('link', { name: /^Roles$/ })).toHaveCount(0)
    await expect(bar.getByRole('link', { name: /^Permissions$/ })).toHaveCount(0)
    await expect(bar.getByRole('link', { name: /^Users$/ })).toHaveCount(0)
  })

  test('navigating to /admin shows the flat-link variant with no sub-nav', async ({ page }) => {
    await withSession(page, { permissions: ['administration.view'] })
    await page.goto('/admin')

    const bar = sidebar(page)
    await expect(bar.getByRole('link', { name: /Administration/i })).toBeVisible()
    // Even on /admin, the Administration item should NOT expand into a sub-nav
    // since the only allowed child IS the parent page.
    await expect(bar.locator('.app-shell__sub-nav-list')).toHaveCount(0)
  })

  test('both permissions reveal full Roles / Permissions / Users sub-nav on /admin', async ({ page }) => {
    await withSession(page, {
      permissions: ['administration.view', 'authorization.manage'],
    })
    await page.goto('/admin')

    const bar = sidebar(page)
    await expect(bar.getByRole('link', { name: /Administration/i })).toBeVisible()
    // Sub-nav should be present and contain all admin pages.
    await expect(bar.locator('.app-shell__sub-nav-list')).toHaveCount(1)
    await expect(bar.getByRole('link', { name: /^Overview$/ })).toBeVisible()
    await expect(bar.getByRole('link', { name: /^Roles$/ })).toBeVisible()
    await expect(bar.getByRole('link', { name: /^Permissions$/ })).toBeVisible()
    await expect(bar.getByRole('link', { name: /^Users$/ })).toBeVisible()
  })

  test('authorization.manage without administration.view still hides Administration', async ({ page }) => {
    // Defensive: the parent gate is administration.view; without it, you don't
    // see Administration at all even if you could otherwise manage roles.
    await withSession(page, { permissions: ['authorization.manage'] })
    await page.goto('/dashboard')

    const bar = sidebar(page)
    await expect(bar.getByRole('link', { name: /Administration/i })).toHaveCount(0)
  })
})
