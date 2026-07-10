/**
 * Regression guard for GitHub issue #844: on a narrow (mobile) viewport the
 * "Recent matches" card clipped its trailing Score / Δ / When columns off the
 * right edge of the card because the auto-layout table let a long opponent
 * username claim min-content width and shove those columns past the card.
 *
 * This is a *layout overflow* bug, so it can only be proven in a real browser:
 * jsdom does no layout, and a vitest assertion that the name span carries
 * `text-overflow: ellipsis` passes against the broken code (the ellipsis never
 * engages until the cell is forced to collapse). The only valid proof is
 * measuring `getBoundingClientRect()` here.
 *
 * The suite runs with MSW OFF (see `playwright.config.ts` webServer env
 * `VITE_ENABLE_MSW: 'false'`), so the API is stubbed via `page.route`.
 */
import { expect, test, type Page, type Route } from '@playwright/test'
import type { components } from '../src/api/schema'
import { sessionResponse } from '../src/test/factories'

const SESSION = sessionResponse({ user: { username: 'rita.kovac' } })

// A deliberately long (38-char) opponent name — this is the value that used to
// blow the trailing columns off the card. Kept as a constant so the truncation
// and `title`-attribute assertions can compare against the exact string.
const LONG_OPPONENT = 'bartholomew.vandersteen.mcallister.iii'

// `satisfies` (not `:`) so tsc fails if the OpenAPI schema drifts away from
// this stub. The e2e suite runs MSW-off, so nothing else would catch it — see
// web-client/CLAUDE.md on page.route stubs going green in vitest and breaking
// here.
const DASHBOARD = {
  attention: [],
  attention_total_count: 0,
  waiting_count: 0,
  rating: null,
  completed_match_count: 2,
  recent_results: [
    {
      match_id: '11111111-1111-4111-8111-111111111111',
      opponent_username: LONG_OPPONENT,
      is_win: true,
      my_games_won: 3,
      opponent_games_won: 1,
      completed_at: '2026-05-12T09:00:00Z',
      my_rating_change: { before: 1500, after: 1512, delta: 12 },
    },
    {
      match_id: '22222222-2222-4222-8222-222222222222',
      opponent_username: 'kim.j',
      is_win: false,
      my_games_won: 1,
      opponent_games_won: 3,
      completed_at: '2026-05-10T09:00:00Z',
      my_rating_change: { before: 1512, after: 1504, delta: -8 },
    },
  ],
} satisfies components['schemas']['DashboardResponse']

async function installDashboardMock(page: Page) {
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
        body: JSON.stringify(DASHBOARD),
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

test.describe('Dashboard recent-results card (#844)', () => {
  test.use({ viewport: { width: 375, height: 667 } })

  test('trailing columns stay within the card at 375px', async ({ page }) => {
    await installDashboardMock(page)
    await page.goto('/dashboard')
    await page.locator('[data-testid="dashboard-recent-results"]').waitFor()

    const m = await page.evaluate(async () => {
      // Text metrics are what we assert on — wait for the web font so the
      // measured widths reflect the rendered glyphs, not a fallback face.
      await document.fonts.ready

      const label = document.querySelector('[data-testid="dashboard-recent-results"]')
      const card = label?.closest('[data-slot="card"]') as HTMLElement | null
      if (!card) throw new Error('recent-results card not found')
      const cardRect = card.getBoundingClientRect()

      const rows = Array.from(card.querySelectorAll('tbody > tr'))
      // Every cell of every row (the short-named row is a regression guard: a
      // table shares one column grid, so the long-name overflow clipped it too).
      const cellOverflows: number[] = []
      for (const row of rows) {
        for (const td of Array.from(row.querySelectorAll('td'))) {
          cellOverflows.push(td.getBoundingClientRect().right - cardRect.right)
        }
      }

      const nameSpan = card.querySelector(
        'tbody > tr:first-child td:first-child span[title]',
      ) as HTMLElement | null
      if (!nameSpan) throw new Error('opponent name span not found')

      // The short-named (second) row's trailing cells: Score / Δ / When.
      const shortRow = rows[1]
      const shortCells = Array.from(shortRow.querySelectorAll('td'))
      const shortRowText = shortCells.map((c) => (c.textContent ?? '').trim())

      return {
        rowCount: rows.length,
        maxCellOverflow: Math.max(...cellOverflows),
        nameScrollWidth: nameSpan.scrollWidth,
        nameClientWidth: nameSpan.clientWidth,
        nameTitle: nameSpan.getAttribute('title'),
        scoreText: shortRowText[1],
        deltaText: shortRowText[2],
        whenText: shortRowText[3],
      }
    })

    // 0. Both rows rendered. Guards the next assertion against passing
    //    vacuously: `Math.max(...[])` is `-Infinity`, which would satisfy it.
    expect(m.rowCount, 'recent-results rows rendered').toBe(
      DASHBOARD.recent_results.length,
    )

    // 1. No cell of any row spills past the right edge of the card. This is the
    //    core #844 probe: the card is pinned to the column width (`minWidth: 0`),
    //    so a broken table overflows *past* the card rather than widening it.
    expect(
      m.maxCellOverflow,
      `worst cell right-edge px past card right-edge (rows: ${DASHBOARD.recent_results.length})`,
    ).toBeLessThanOrEqual(1)

    // 2. The long name is genuinely clipped (ellipsis engaged), not merely
    //    styled to clip.
    expect(
      m.nameScrollWidth,
      'long opponent name span.scrollWidth must exceed clientWidth (truncated)',
    ).toBeGreaterThan(m.nameClientWidth)

    // 3. The full name is preserved for hover/accessibility via `title`.
    expect(m.nameTitle, 'name span title = full opponent username').toBe(
      LONG_OPPONENT,
    )

    // 4. The short-named row rendered with real content. These are render
    //    smoke-checks, NOT clipping checks — `overflow: hidden` only hides
    //    pixels, so a fully-clipped cell still reports its textContent.
    //    Assertion 1 is the only thing that proves the columns are on-card.
    expect(m.scoreText, 'short row score cell').toBe('1-3')
    expect(m.deltaText, 'short row rating-delta cell').toBe('-8')
    expect(m.whenText, 'short row when cell').not.toBe('')
  })
})
