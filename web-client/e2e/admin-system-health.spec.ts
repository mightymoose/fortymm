import { expect, test } from '@playwright/test'
import { AdminPage } from './page-objects/admin.page'

test.describe('Administration · System Health', () => {
  test('renders the Administration heading', async ({ page }) => {
    const admin = await AdminPage.navigateTo(page)
    await expect(admin.heading).toBeVisible()
  })

  test('shows operational state when every dependency is healthy', async ({
    page,
  }) => {
    const admin = await AdminPage.navigateTo(page, { scenario: 'healthy' })

    await expect(admin.widget).toHaveAttribute('data-state', 'ok')
    await expect(admin.eyebrow).toHaveText('Operational')

    await expect(admin.row('redis')).toHaveAttribute('data-status', 'ok')
    await expect(admin.row('database')).toHaveAttribute('data-status', 'ok')
    await expect(admin.row('solver')).toHaveAttribute('data-status', 'ok')

    await expect(admin.pill('redis')).toHaveText('healthy')
    await expect(admin.pill('database')).toHaveText('healthy')
    await expect(admin.pill('solver')).toHaveText('healthy')

    await expect(admin.widget).toContainText('All systems')
    await expect(admin.widget).toContainText('go')
  })

  test('flags a slow dependency as degraded', async ({ page }) => {
    const admin = await AdminPage.navigateTo(page, { scenario: 'degraded' })

    await expect(admin.widget).toHaveAttribute('data-state', 'deg')
    await expect(admin.eyebrow).toHaveText('Partial degradation')

    await expect(admin.row('database')).toHaveAttribute('data-status', 'deg')
    await expect(admin.pill('database')).toHaveText('degraded')

    await expect(admin.row('redis')).toHaveAttribute('data-status', 'ok')
    await expect(admin.row('solver')).toHaveAttribute('data-status', 'ok')

    await expect(admin.widget).toContainText('sluggish')
  })

  test('surfaces error chips and bad state when a dependency is down', async ({
    page,
  }) => {
    const admin = await AdminPage.navigateTo(page, { scenario: 'failing' })

    await expect(admin.widget).toHaveAttribute('data-state', 'bad')
    await expect(admin.eyebrow).toHaveText('Interruption')

    await expect(admin.row('database')).toHaveAttribute('data-status', 'bad')
    await expect(admin.row('solver')).toHaveAttribute('data-status', 'bad')

    await expect(admin.pill('database')).toHaveText('down')
    await expect(admin.pill('solver')).toHaveText('down')

    await expect(admin.errorChip('database')).toContainText(
      'connection refused (ECONNREFUSED)',
    )
    await expect(admin.errorChip('solver')).toContainText('OOMKilled')

    await expect(admin.widget).toContainText('down')
  })

  test('treats a 5xx response as a bad overall state', async ({ page }) => {
    const admin = await AdminPage.navigateTo(page, { scenario: 'serverError' })

    await expect(admin.widget).toHaveAttribute('data-state', 'bad')
    await expect(admin.row('redis')).toHaveAttribute('data-status', 'bad')
    await expect(admin.row('database')).toHaveAttribute('data-status', 'bad')
    await expect(admin.row('solver')).toHaveAttribute('data-status', 'bad')
  })

  test('shows checking state while a refetch is in flight, then resolves', async ({
    page,
  }) => {
    const admin = await AdminPage.navigateTo(page, { scenario: 'failing' })

    await expect(admin.widget).toHaveAttribute('data-state', 'bad')

    let resolvePending: (() => void) | null = null
    await admin.page.unroute('**/v1/health')
    await admin.page.route('**/v1/health', async (route) => {
      await new Promise<void>((resolve) => {
        resolvePending = resolve
      })
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          redis: { healthy: true, latency_ms: 4 },
          database: { healthy: true, latency_ms: 12 },
          solver: { healthy: true, latency_ms: 38 },
        }),
      })
    })

    await admin.recheckButton.click()
    await expect(admin.eyebrow).toHaveText('Checking')
    await expect(admin.widget).toHaveAttribute('data-state', 'loading')
    await expect(admin.recheckButton).toBeDisabled()

    resolvePending?.()

    await expect(admin.widget).toHaveAttribute('data-state', 'ok')
    await expect(admin.eyebrow).toHaveText('Operational')
    await expect(admin.recheckButton).toBeEnabled()
  })

  test('refetches when the recheck button is clicked', async ({ page }) => {
    let calls = 0
    const admin = await AdminPage.navigateTo(page, {
      scenario: 'healthy',
      onHealthRequest: () => {
        calls += 1
      },
    })

    await expect(admin.widget).toHaveAttribute('data-state', 'ok')
    expect(calls).toBe(1)

    await admin.recheckButton.click()
    await expect.poll(() => calls).toBe(2)
    await expect(admin.widget).toHaveAttribute('data-state', 'ok')
  })
})
