import type { BrowserContext } from '@playwright/test'
import type { components } from '../../src/api/schema.d.ts'

export const stubbedSession: components['schemas']['SessionResponse'] = {
  data: {
    account: {
      id: '0b9e3c1e-58f4-4c84-9a59-2d0b6f3f6a10',
      kind: 'guest',
      email: null,
      player: {
        id: 'c4a8f6a2-1f0e-4a63-8d2e-7f5b9e1c3d42',
        display_name: 'excited egret 387',
      },
      permissions: [],
    },
  },
}

const SESSION_URL = '**/api/v1/session'

// A page load starts a guest account. Specs that check the Worker, the
// assets or the service worker, not the session, answer it here and make no
// account. Then the session-limit project still has most of this client's
// budget. On the context, because a page's route doesn't see the requests
// of a page that the service worker controls.
export async function stubSession(context: BrowserContext): Promise<() => Promise<void>> {
  await context.route(SESSION_URL, (route) => route.fulfill({ json: stubbedSession }))
  return () => context.unroute(SESSION_URL)
}
