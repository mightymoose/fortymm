import { expect, test, type Page, type Route } from '@playwright/test'
import {
  matchListResponse,
  matchListRow,
  sessionResponse,
} from '../src/test/factories'

const SESSION = sessionResponse({ user: { username: 'rita.kovac' } })

/** Three seeded matches across statuses, plus a "Score" CTA on the live row.
 *  Each row exists in `mock` because the API filters by `status` server-side;
 *  the page never has to filter client-side. */
const SEED = [
  matchListRow({
    id: 'm-live-1',
    opponent_username: 'nguyen.t',
    status: 'in_progress',
    status_label: 'Live',
    my_games_won: 1,
    opponent_games_won: 1,
    current_game_id: 'g-live-1-3',
  }),
  matchListRow({
    id: 'm-pending-1',
    opponent_username: 'okafor.d',
    status: 'pending',
    status_label: 'Scheduled',
    current_game_id: 'g-pending-1-1',
  }),
  matchListRow({
    id: 'm-final-1',
    opponent_username: 'silva.r',
    status: 'completed',
    status_label: 'Final',
    my_games_won: 3,
    opponent_games_won: 1,
    is_win: true,
    current_game_id: null,
  }),
]

/** Mount a `GET /v1/matches` stub that filters seeded rows by the requested
 *  status and paginates them. Records every request so specs can assert the
 *  client sent the right query string. */
async function installListMock(page: Page, rows = SEED, pageSize = 25) {
  const requests: URL[] = []
  await page.route('**/api/v1/**', (route: Route) => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace(/^\/api/, '')
    if (path === '/v1/session') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SESSION),
      })
    }
    if (path === '/v1/matches' && route.request().method() === 'GET') {
      requests.push(url)
      const status = url.searchParams.get('status')
      const pageNum = Number(url.searchParams.get('page') ?? '1')
      const filtered = status ? rows.filter((r) => r.status === status) : rows
      const start = (pageNum - 1) * pageSize
      const slice = filtered.slice(start, start + pageSize)
      const counts: Record<string, number> = {
        pending: rows.filter((r) => r.status === 'pending').length,
        in_progress: rows.filter((r) => r.status === 'in_progress').length,
        completed: rows.filter((r) => r.status === 'completed').length,
        disputed: 0,
        voided: 0,
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          matchListResponse({
            items: slice,
            total: filtered.length,
            page: pageNum,
            page_size: pageSize,
            status_counts: counts,
          }),
        ),
      })
    }
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ detail: `unmocked ${route.request().method()} ${path}` }),
    })
  })
  return requests
}

test.describe('Matches list', () => {
  test('renders the seeded matches', async ({ page }) => {
    await installListMock(page)
    await page.goto('/matches')

    await expect(page.getByText('nguyen.t')).toBeVisible()
    await expect(page.getByText('okafor.d')).toBeVisible()
    await expect(page.getByText('silva.r')).toBeVisible()
  })

  test('filters down to the live tab', async ({ page }) => {
    await installListMock(page)
    await page.goto('/matches')
    // Wait for the initial render so the tab interactions land after data.
    await expect(page.getByText('nguyen.t')).toBeVisible()

    await page.getByRole('tab', { name: /^live/i }).click()

    await expect(page.getByText('nguyen.t')).toBeVisible()
    await expect(page.getByText('okafor.d')).not.toBeVisible()
    await expect(page.getByText('silva.r')).not.toBeVisible()
  })

  test('opens the match details page when a row is clicked', async ({ page }) => {
    await installListMock(page)
    await page.goto('/matches')

    // The details page itself isn't mocked here — asserting the URL change is
    // enough to prove the row navigated.
    await page.getByText('nguyen.t').click()
    await expect(page).toHaveURL(/\/matches\/m-live-1$/)
  })

  test('shows the pagination footer when total exceeds page size', async ({
    page,
  }) => {
    const many = Array.from({ length: 30 }, (_, i) =>
      matchListRow({
        id: `m-${i}`,
        opponent_username: `opp-${i}`,
        status: 'pending',
      }),
    )
    await installListMock(page, many)
    await page.goto('/matches')

    // Showing 1–25 of 30 — confirms the footer rendered with the API total.
    await expect(page.getByText(/Showing/i)).toContainText('1–25')
    await expect(page.getByText(/Showing/i)).toContainText('30')
    await expect(page.getByRole('button', { name: /next page/i })).toBeEnabled()
  })
})
