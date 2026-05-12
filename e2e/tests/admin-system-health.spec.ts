import { expect, test } from '@playwright/test'

test.describe('Administration · System Health (live stack)', () => {
  test('the admin page reports every dependency as healthy', async ({
    page,
  }) => {
    await page.goto('/admin')

    await expect(
      page.getByRole('heading', { level: 1, name: 'Administration' }),
    ).toBeVisible()

    const widget = page.getByTestId('system-health')
    await expect(widget).toBeVisible()
    await expect(widget).toHaveAttribute('data-state', 'ok', { timeout: 30_000 })

    for (const service of ['redis', 'database', 'solver'] as const) {
      await expect(page.getByTestId(`system-health-row-${service}`)).toHaveAttribute(
        'data-status',
        'ok',
      )
      await expect(page.getByTestId(`system-health-pill-${service}`)).toHaveText(
        'healthy',
      )
    }

    await expect(page.getByTestId('system-health-eyebrow')).toHaveText(
      'Operational',
    )
  })
})
