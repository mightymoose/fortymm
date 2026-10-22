import { expect, type Locator, type Page } from '@playwright/test'

// The loading screen the app shows over every page on a full page load.
export function loadingScreen(page: Page): Locator {
  return page.getByRole('status', { name: 'Loading FortyMM' })
}

// Waits for the loading screen to show and then go, so the page under it can
// be clicked and screenshotted. Waiting only for it to be hidden would pass
// before React first renders it.
export async function waitForLoadingScreen(page: Page): Promise<void> {
  const screen = loadingScreen(page)
  await expect(screen).toBeVisible()
  await expect(screen).toBeHidden({ timeout: 10_000 })
}
