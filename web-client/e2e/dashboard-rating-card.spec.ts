/**
 * The dashboard's rating hero, in a real browser (#952).
 *
 * A player whose only rated match was their FIRST holds a rating that match
 * *established* — it did not move one. On the wire that is `DashboardRating.delta
 * === null`. The card must then print the number and **no chip at all**: the 1500
 * a league-join seeds is a prior, not a rating anyone held, so there is nothing to
 * have fallen from. The card used to read `delta` straight, and `null >= 0` is
 * `false` in JS, so a brand-new player's first-ever 1268 was announced as a
 * loss-toned "−232 last match" — while the Δ column of the very same match, on the
 * very same page, correctly read "—".
 *
 * This suite runs with MSW OFF (see `playwright.config.ts` webServer env
 * `VITE_ENABLE_MSW: 'false'`), so the API is stubbed via `page.route`. That makes
 * these stubs the *only* place a browser ever sees the delta-less shape — vitest's
 * MSW handlers can't cover it (web-client/CLAUDE.md).
 */
import { expect, test, type Page, type Route } from '@playwright/test'
import type { components } from '../src/api/schema'
import { sessionResponse } from '../src/test/factories'
import { fulfillParkedStream, STREAM_PATH } from './support/realtime'

const SESSION = sessionResponse({ user: { username: 'rita.kovac' } })

type DashboardResponse = components['schemas']['DashboardResponse']

/** The prior a league-join seeds. It is not a rating anyone holds, and it must
 * appear nowhere on the dashboard of a player one match old. */
const SEEDED_PRIOR = '1500'

// `satisfies` (not `:`) so tsc fails if the OpenAPI schema drifts away from these
// stubs — nothing else would catch it in an MSW-off suite.

/** One rated match, and it ESTABLISHED the rating: `delta` is null, and the spark
 * carries the single rated result (never the seed row). */
const ESTABLISHED_DASHBOARD = {
  attention: [],
  attention_total_count: 0,
  waiting_count: 0,
  completed_match_count: 1,
  rating: {
    state: 'RATED',
    league_id: '44444444-4444-4444-8444-444444444444',
    league_name: 'FortyMM',
    strategy_key: 'glicko2',
    current: 1268,
    delta: null,
    peak: 1268,
    percentile: 22,
    rank: null,
    population: null,
    spark_data: [1268],
    streak: { kind: 'L', n: 1 },
    stats: [
      { label: 'RD', value: '332' },
      { label: 'Volatility', value: '0.060' },
    ],
  },
  recent_results: [
    {
      match_id: '33333333-3333-4333-8333-333333333333',
      opponent_username: 'ada.lovelace',
      is_win: false,
      my_games_won: 0,
      opponent_games_won: 3,
      completed_at: '2026-05-08T09:00:00Z',
      my_rating_change: { before: null, after: 1268, delta: null },
    },
  ],
  // No live tournament, so the dashboard's tournament panel never renders here
  // — this suite is about the rating hero beneath it.
  tournaments: [],
} satisfies DashboardResponse

/** A player with a real history: the last match MOVED them, so the chip is there
 * and signed. The control case — the fix must not silence a genuine delta. */
const MOVED_DASHBOARD = {
  ...ESTABLISHED_DASHBOARD,
  completed_match_count: 9,
  rating: {
    ...ESTABLISHED_DASHBOARD.rating,
    current: 1536,
    delta: -8,
    peak: 1560,
    spark_data: [1500, 1524, 1544, 1536],
    streak: { kind: 'L', n: 1 },
  },
} satisfies DashboardResponse

async function installDashboardMock(page: Page, dashboard: DashboardResponse) {
  await page.route('**/api/v1/**', (route: Route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    // The realtime stream is not JSON, so it cannot fall through to the `[]`
    // below — see `./support/realtime`.
    if (path === STREAM_PATH) return fulfillParkedStream(route)
    if (path === '/v1/session') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SESSION),
      })
    }
    if (path === '/v1/dashboard') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(dashboard),
      })
    }
    // Anything else the AppShell/dashboard happens to fetch on load.
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    })
  })
}

/** The rating hero — the card whose overline is "Current rating". */
const ratingCard = (page: Page) =>
  page.locator('[data-slot="card"]').filter({ hasText: 'Current rating' })

test.describe('Dashboard rating card (#952)', () => {
  test('a first rated match ESTABLISHES the rating: number, no chip', async ({
    page,
  }) => {
    await installDashboardMock(page, ESTABLISHED_DASHBOARD)
    await page.goto('/dashboard')

    const card = ratingCard(page)
    await expect(card).toContainText('1268')

    // The whole point: no "last match" movement is reported, because the match
    // reported no movement — it brought the rating into existence.
    await expect(card).not.toContainText('last match')
    await expect(card).not.toContainText(/[+-]?\d+ last match/)
    // And no trace of the phantom the chip used to be measured from.
    await expect(card).not.toContainText(SEEDED_PRIOR)
    await expect(card).not.toContainText('232')

    // The trend line is a single rated point padded flat — not a slope out of a
    // 1500 that never existed. Both ends of the stroked path sit at the same y.
    const ys = await card
      .locator('[data-testid="dashboard-sparkline"] path[stroke]')
      .evaluate((path) =>
        [...(path.getAttribute('d') ?? '').matchAll(/[ML][\d.]+ ([\d.]+)/g)].map(
          (m) => Number(m[1]),
        ),
      )
    expect(ys, 'padded single-point spark = two points').toHaveLength(2)
    expect(ys[0], 'the spark of an established rating is flat').toBe(ys[1])
  })

  test('a player with a history still gets their signed delta chip', async ({
    page,
  }) => {
    await installDashboardMock(page, MOVED_DASHBOARD)
    await page.goto('/dashboard')

    const card = ratingCard(page)
    await expect(card).toContainText('1536')
    await expect(card).toContainText('-8 last match')
  })
})
