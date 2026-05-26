import { expect, test, type Page, type Route } from '@playwright/test'
import {
  matchListResponse,
  matchListRow,
  sessionResponse,
} from '../src/test/factories'

const SESSION = sessionResponse({ user: { username: 'rita.kovac' } })
const PAGE_SIZE = 25

const SEED = [
  matchListRow({
    id: 'm-live-1',
    opponent: 'nguyen.t',
    status: 'in_progress',
    status_label: 'Live',
    current_game_number: 3,
  }),
  matchListRow({
    id: 'm-pending-1',
    opponent: 'okafor.d',
    status: 'pending',
    status_label: 'Scheduled',
    current_game_number: 1,
  }),
  matchListRow({
    id: 'm-final-1',
    opponent: 'silva.r',
    status: 'completed',
    status_label: 'Final',
    current_game_number: null,
  }),
]

// `status_counts` is computed off the unfiltered `rows` so tab badges reflect
// the full histogram regardless of which status the request asked for; `total`
// uses the filtered set so the footer matches the visible page.
async function installListMock(page: Page, rows = SEED) {
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
      const status = url.searchParams.get('status')
      const pageNum = Number(url.searchParams.get('page') ?? '1')
      const filtered = status ? rows.filter((r) => r.status === status) : rows
      const start = (pageNum - 1) * PAGE_SIZE
      const slice = filtered.slice(start, start + PAGE_SIZE)
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
            page_size: PAGE_SIZE,
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
}

test.describe('Matches list', () => {
  test.beforeEach(async ({ page }) => {
    await installListMock(page)
  })

  test('renders the seeded matches', async ({ page }) => {
    await page.goto('/matches')

    await expect(page.getByText('nguyen.t')).toBeVisible()
    await expect(page.getByText('okafor.d')).toBeVisible()
    await expect(page.getByText('silva.r')).toBeVisible()
  })

  test('filters down to the live tab', async ({ page }) => {
    await page.goto('/matches')
    await expect(page.getByText('nguyen.t')).toBeVisible()

    await page.getByRole('tab', { name: /^live/i }).click()

    await expect(page.getByText('nguyen.t')).toBeVisible()
    await expect(page.getByText('okafor.d')).toHaveCount(0)
    await expect(page.getByText('silva.r')).toHaveCount(0)
  })

  test('opens the match details page when a row is clicked', async ({ page }) => {
    await page.goto('/matches')

    await page.getByText('nguyen.t').click()
    await expect(page).toHaveURL(/\/matches\/m-live-1$/)
  })
})

test.describe('Matches list — pagination', () => {
  test('shows the pagination footer when total exceeds page size', async ({
    page,
  }) => {
    const many = Array.from({ length: 30 }, (_, i) =>
      matchListRow({
        id: `m-${i}`,
        opponent: `opp-${i}`,
        status: 'pending',
      }),
    )
    await installListMock(page, many)
    await page.goto('/matches')

    await expect(page.getByText(/Showing/i)).toContainText('1–25')
    await expect(page.getByText(/Showing/i)).toContainText('30')
    await expect(page.getByRole('button', { name: /next page/i })).toBeEnabled()
  })
})
