import type { Page } from '@playwright/test'

/** Keep the app shell's unread-count request inside the mocked test boundary. */
export async function stubUnreadNotifications(page: Page): Promise<void> {
  await page.route('**/v1/notifications/unread-count', (route) =>
    route.fulfill({ json: { unread_count: 0 } }),
  )
}
