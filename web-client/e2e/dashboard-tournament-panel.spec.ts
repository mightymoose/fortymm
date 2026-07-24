/**
 * The dashboard's tournament panel, in a real browser.
 *
 * This suite runs with MSW OFF (see `playwright.config.ts` webServer env
 * `VITE_ENABLE_MSW: 'false'`), so the API is stubbed via `page.route` — which
 * makes these stubs the only place a browser ever sees the panel's wire shape
 * (web-client/CLAUDE.md). vitest exercises the projection and the components
 * against hand-built views; this exercises the whole path from a
 * `DashboardResponse` to painted pixels, including that the panel really is the
 * first thing under the greeting.
 */
import { expect, test, type Page, type Route } from '@playwright/test'
import type { components } from '../src/api/schema'
import { sessionResponse } from '../src/test/factories'

const SESSION = sessionResponse({ user: { username: 'mightymoose' } })

type DashboardResponse = components['schemas']['DashboardResponse']

// `satisfies` (not `:`) so tsc fails if the OpenAPI schema drifts away from
// this stub — nothing else would catch it in an MSW-off suite.

/** A player mid-tournament: a live best-of-five on Table 4, 2–1 up, game 4 next. */
const IN_A_TOURNAMENT = {
  attention: [],
  attention_total_count: 0,
  waiting_count: 0,
  rating: null,
  completed_match_count: 1,
  recent_results: [],
  tournaments: [
    {
      id: '55555555-5555-4555-8555-555555555555',
      name: 'Riverside Summer Slam',
      subtitle: 'Riverside TTC · Jul 24–25',
      live_count: 1,
      events: [
        {
          id: '66666666-6666-4666-8666-666666666666',
          name: 'U1500 · Group B',
          draw_type: 'round-robin',
          is_live: true,
          wins: 1,
          losses: 0,
          position: 1,
          field_size: 4,
          stage_label: 'Group play',
          pool_label: 'Pool B',
          match: {
            state: 'live',
            match_id: '77777777-7777-4777-8777-777777777777',
            opponent_username: 'slim-manatee',
            your_games: 2,
            opponent_games: 1,
            best_of: 5,
            games: [
              { number: 1, your_points: 11, opponent_points: 7 },
              { number: 2, your_points: 8, opponent_points: 11 },
              { number: 3, your_points: 11, opponent_points: 9 },
            ],
            round_label: 'Group match 2',
            table_label: 'Table 4',
            start_label: '4:30 PM CDT',
            next_game_number: 4,
            you_won: null,
          },
          fixtures: [
            {
              label: 'M1',
              opponent_username: 'celestial-caracara',
              state: 'completed',
              detail: 'Won 3–1',
              you_won: true,
              match_id: '88888888-8888-4888-8888-888888888888',
            },
            {
              label: 'M2',
              opponent_username: 'slim-manatee',
              state: 'live',
              detail: 'In progress',
              you_won: null,
              match_id: '77777777-7777-4777-8777-777777777777',
            },
            {
              label: 'M3',
              opponent_username: 'bold-bison',
              state: 'upcoming',
              detail: '5:20 PM CDT · Table 6',
              you_won: null,
              match_id: null,
            },
          ],
        },
      ],
    },
  ],
} satisfies DashboardResponse

/** The same player between tournaments — the shape almost every load has. */
const IN_NO_TOURNAMENT = {
  ...IN_A_TOURNAMENT,
  tournaments: [],
} satisfies DashboardResponse

async function installDashboardMock(page: Page, dashboard: DashboardResponse) {
  await page.route('**/api/v1/**', (route: Route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
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
    // Anything else the AppShell happens to fetch on load.
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    })
  })
}

const panel = (page: Page) =>
  page.locator('[data-testid="dashboard-tournament-panel"]')

test.describe('Dashboard tournament panel', () => {
  test('puts the live match at the top of the dashboard', async ({ page }) => {
    await installDashboardMock(page, IN_A_TOURNAMENT)
    await page.goto('/dashboard')

    const block = panel(page)
    await expect(block).toContainText('Riverside Summer Slam')
    await expect(block).toContainText('Riverside TTC · Jul 24–25')
    await expect(block).toContainText('1 live now')
    await expect(block).toContainText('Live · Table 4 · Game 4')
    await expect(block).toContainText('Best of 5')

    // It is the first block of the page's content — a player standing at a
    // table must not have to scroll past anything to find their match.
    const blocks = page.locator(
      '[data-testid="dashboard-tournament-panel"], [data-testid="dashboard-attention-panel"]',
    )
    await expect(blocks.first()).toHaveAttribute(
      'data-testid',
      'dashboard-tournament-panel',
    )
  })

  test('deep-links the primary action to the game about to be played', async ({
    page,
  }) => {
    await installDashboardMock(page, IN_A_TOURNAMENT)
    await page.goto('/dashboard')

    await expect(
      panel(page).getByRole('link', { name: 'Enter Game 4 result' }),
    ).toHaveAttribute(
      'href',
      '/matches/77777777-7777-4777-8777-777777777777/games/4/scores/new',
    )
  })

  test('shows the standings and the rest of the schedule', async ({ page }) => {
    await installDashboardMock(page, IN_A_TOURNAMENT)
    await page.goto('/dashboard')

    const block = panel(page)
    await expect(block).toContainText('1st')
    await expect(block).toContainText('of 4')
    await expect(block).toContainText('Group play')
    await expect(block).toContainText('Won 3–1')
    await expect(block).toContainText('In progress')
    await expect(block).toContainText('5:20 PM CDT · Table 6')
  })

  test('renders nothing at all between tournaments', async ({ page }) => {
    await installDashboardMock(page, IN_NO_TOURNAMENT)
    await page.goto('/dashboard')

    // Wait for the page itself before asserting an absence, so a slow load
    // cannot pass as "no panel".
    await expect(page.getByRole('heading', { name: /^Hi, / })).toBeVisible()
    await expect(panel(page)).toHaveCount(0)
  })

  test('stays inside the viewport at 375px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 })
    await installDashboardMock(page, IN_A_TOURNAMENT)
    await page.goto('/dashboard')

    await expect(panel(page)).toBeVisible()
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)
  })
})
