import { DashboardPage } from "./dashboard.page.ts";
import { expect, test } from '@playwright/test'

test('the dashboard shows its heading', async ({ page }) => {
  const dashboardPage = new DashboardPage(page);
  await dashboardPage.goto()
  await expect(dashboardPage.heading).toBeVisible()
})
