import { type Page } from '@playwright/test'

// Where the design system reference (requirements/design-system/reference/) is served: the
// design-system compose service, reached by name on the compose network.
const referenceUrl = process.env.DESIGN_SYSTEM_URL ?? 'http://design-system'

export async function gotoReference(page: Page, board: string) {
  await page.goto(`${referenceUrl}/${board}`)
}
