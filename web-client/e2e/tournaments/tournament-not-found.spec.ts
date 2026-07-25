/**
 * The tournament detail route's not-found taxonomy, in a real browser (ADR-1001,
 * #992/#1050/#1090).
 *
 * Two different bad URLs must both reach the route's `notFoundComponent`, and the
 * *malformed* one must do it **without touching the API** — the whole of #992 was
 * that `/tournaments/abc` hit the server and painted a raw Pydantic "Input should
 * be a valid UUID" string into the error boundary. Only a real browser exercises
 * the router wiring (`params.parse` → `notFound()`, and the query's 404 →
 * `notFound()`), so it is pinned here rather than only in vitest.
 *
 * **MSW is OFF in this suite** (`playwright.config.ts` → `VITE_ENABLE_MSW:
 * 'false'`): the network is stubbed by `TournamentsStore`'s inline `page.route`
 * interceptors, and the malformed-id assertion reads that store's request log to
 * prove no detail fetch went out.
 */
import { expect, test } from '@playwright/test'

import { TournamentsStore } from '../page-objects/tournaments/tournaments-store'

/** A well-formed uuid that names no tournament — the "valid but unknown" case,
 * which the store's catch-all answers with a 404 (as the server would). */
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000'

/** Did the app fetch a tournament DETAIL (a `/v1/tournaments/{id}` GET, not the
 * bare list)? The malformed-id case must answer no. */
function detailFetches(store: TournamentsStore): number {
  return store.requests.filter(
    (r) => r.method === 'GET' && /^\/v1\/tournaments\/[^/]+$/.test(r.path),
  ).length
}

test.describe('Tournament detail · a missing tournament is a not-found, not an error', () => {
  test('a MALFORMED id reaches the designed not-found — with no fetch and no validator string', async ({
    page,
  }) => {
    const store = new TournamentsStore()
    await store.install(page)

    await page.goto('/tournaments/abc')

    await expect(
      page.getByRole('heading', { name: 'Tournament not found.' }),
    ).toBeVisible()
    // #992: the raw Pydantic validator string never reaches the screen…
    await expect(page.getByText(/valid uuid/i)).toHaveCount(0)
    // …because the request was never made. The route rejected the id at its edge.
    expect(detailFetches(store)).toBe(0)
    // The one recovery action, and it is a real link to the list.
    const back = page.getByRole('link', { name: 'Back to tournaments' })
    await expect(back).toBeVisible()
    await expect(back).toHaveAttribute('href', '/tournaments')
    // The body renders inside the ONE app shell it already sits under — not a
    // second one nested by a shell-wrapping 404 (ADR-1001).
    await expect(page.getByRole('main')).toHaveCount(1)
  })

  test('a well-formed-but-unknown id (a 404) reaches the same not-found — and this one DID fetch', async ({
    page,
  }) => {
    const store = new TournamentsStore()
    await store.install(page)

    await page.goto(`/tournaments/${UNKNOWN_ID}`)

    await expect(
      page.getByRole('heading', { name: 'Tournament not found.' }),
    ).toBeVisible()
    // Unlike the malformed case, the client cannot tell valid-unknown from
    // valid-known without asking — so it really did ask.
    expect(detailFetches(store)).toBeGreaterThan(0)
  })

  test('the not-found is not a dead end — “Back to tournaments” lands on the list', async ({
    page,
  }) => {
    const store = new TournamentsStore()
    await store.install(page)

    await page.goto('/tournaments/abc')
    await page.getByRole('link', { name: 'Back to tournaments' }).click()

    await expect(page).toHaveURL(/\/tournaments$/)
    // The list really rendered — a dead-end link that only changed the URL would
    // still be a dead end.
    await expect(page.getByRole('heading', { name: 'Tournaments' })).toBeVisible()
  })
})
