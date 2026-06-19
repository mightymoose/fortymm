import { expect, test } from '@playwright/test'

test.describe('Administration · System Health (live stack)', () => {
  test('denies a guest without administration.view and hides the dashboard', async ({
    page,
  }) => {
    // Regression for #622, end-to-end against the real stack: the live session
    // is a freshly-minted guest with no roles (so no `administration.view`).
    // The Overview's only fetch — `GET /v1/health` — is public and never 403s,
    // so before the client-side gate this page rendered the system-health
    // dashboard (and its internal service hostnames) to anyone. It must now
    // refuse to render the dashboard and show the access-denied panel instead.
    await page.goto('/admin')

    await expect(
      page.getByText("You don't have access to this page"),
    ).toBeVisible()

    // The dashboard (and the internal hostnames it lists) must stay out of the DOM.
    await expect(page.getByTestId('system-health')).toHaveCount(0)
    await expect(
      page.getByRole('heading', { level: 1, name: 'Administration' }),
    ).toHaveCount(0)
  })
})
