import type { Page, Route } from '@playwright/test'

import {
  PARKED_STREAM_BODY,
  SSE_CONTENT_TYPE,
} from '../../src/mocks/realtime-stream'

/**
 * The `/v1/stream` stub for **this** suite, which runs with MSW OFF.
 *
 * Every authenticated surface opens a realtime connection
 * (`routes/_app/route.tsx`), so every spec that visits one has to answer it —
 * and vitest cannot catch a spec that doesn't, because vitest is mocked by MSW
 * and this suite is mocked by inline `page.route` interceptors. Left unstubbed
 * the stream lands in whichever of two bad places the spec has arranged:
 *
 * - a `**\/api/v1/**` catch-all answers `[]` with `application/json`, which the
 *   reader treats as a stream that opened and immediately ended, or
 * - nothing matches at all, and vite's SPA fallback returns `index.html` —
 *   a 200 of HTML that decodes to no frames and then ends.
 *
 * Either way the client is inside its reconnect loop for the rest of the spec,
 * adding request noise to every store that tallies requests and a background
 * fetch to every screenshot.
 *
 * The body parks it (see `src/mocks/realtime-stream.ts`): a `retry:` of an hour,
 * which the client adopts as its reconnect base, so the one connection this
 * fulfilment closes is the only one the spec ever sees.
 *
 * Two ways in, because the specs stub the network two ways:
 *
 * - **A spec that owns a `**\/api/v1/**` catch-all** adds `fulfillParkedStream`
 *   as one more branch inside its handler — exactly as
 *   `tournaments-store.ts` already special-cases
 *   `/v1/notifications/unread-count`. It cannot call `stubRealtimeStream`
 *   instead: Playwright matches the most-recently-registered route first, so a
 *   catch-all registered afterwards would shadow it.
 * - **A spec with only path-specific routes** calls `stubRealtimeStream(page)`
 *   in setup.
 */

/** The path `/v1/stream` lands on, after the `/api` prefix is stripped — the
 * form the catch-all handlers already compare against. */
export const STREAM_PATH = '/v1/stream'

/** Answer one intercepted stream request with a parked stream. */
export function fulfillParkedStream(route: Route): Promise<void> {
  return route.fulfill({
    status: 200,
    contentType: SSE_CONTENT_TYPE,
    headers: { 'Cache-Control': 'no-cache' },
    body: PARKED_STREAM_BODY,
  })
}

/** Register a dedicated `/v1/stream` interceptor. For specs with no catch-all —
 * see the module note. */
export async function stubRealtimeStream(page: Page): Promise<void> {
  await page.route('**/v1/stream', (route) => fulfillParkedStream(route))
}
