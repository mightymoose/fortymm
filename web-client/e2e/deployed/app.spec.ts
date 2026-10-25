import type { components } from '../../src/api/schema.d.ts'
import { expect, test } from '../fixtures.ts'

const session: components['schemas']['SessionResponse'] = {
  data: {
    account: {
      id: '0b9e3c1e-58f4-4c84-9a59-2d0b6f3f6a10',
      kind: 'guest',
      email: null,
      player: {
        id: 'c4a8f6a2-1f0e-4a63-8d2e-7f5b9e1c3d42',
        display_name: 'excited egret 387',
      },
    },
  },
}

// A page load starts a guest account. These specs check the Worker and the
// assets, not the session, so they answer it here and make no account. Then
// the session-limit project still has most of this client's budget.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/session', (route) => route.fulfill({ json: session }))
})

test('serves the app', async ({ homePage }) => {
  await homePage.goto()

  await expect(homePage.title).toHaveText('What’s coming, and when.')
})

// No file matches the path, so this loads through the SPA fallback.
test('serves client-side routes', async ({ designSystemPage }) => {
  await designSystemPage.goto()

  await expect(designSystemPage.title).toHaveText('Design System')
})
