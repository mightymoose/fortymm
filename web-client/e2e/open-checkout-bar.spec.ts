/**
 * The app-wide open-checkout bar (#1809), through a real browser.
 *
 * `GET /v1/me/checkouts/open` is a NEW call the app shell makes on every
 * signed-in page — this suite runs with MSW off (`web-client/CLAUDE.md`), so
 * only a `page.route` stub, not vitest, can prove the bar's geometry (it
 * sits under the header, never over `main`) and that the tournament whose
 * OWN Events tab is on screen is left out of the list — both claims jsdom's
 * layout-free DOM cannot make.
 */
import { expect, test, type Page, type Route } from '@playwright/test'

import type { components } from '../src/api/schema'
import { buildOpenCheckoutRead } from '../src/mocks/factories/checkouts/open-checkout.factory'
import { buildTournamentDetailRead } from '../src/mocks/factories/tournaments/tournament.factory'
import { sessionResponse, unratedDashboardRating } from '../src/test/factories'
import { fulfillParkedStream, STREAM_PATH } from './support/realtime'

type DashboardResponse = components['schemas']['DashboardResponse']
type OpenTournamentCheckoutRead = components['schemas']['OpenTournamentCheckout']

const SESSION = sessionResponse({ user: { username: 'rita.kovac' } })

const EMPTY_DASHBOARD = {
  attention: [],
  attention_total_count: 0,
  waiting_count: 0,
  rating: unratedDashboardRating(),
  completed_match_count: 0,
  recent_results: [],
  tournaments: [],
} satisfies DashboardResponse

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

/**
 * The whole shell's network, for a spec about a component the shell mounts
 * on every page: session, the bell, the realtime stream, the dashboard read,
 * `GET /v1/me/checkouts/open` itself, and — for the "absent on its own tab"
 * case — a bare, event-less tournament detail for WHATEVER id the bar links
 * to, so following its own Resume link lands on a real page instead of the
 * vite dev server's `index.html` SPA fallback.
 */
async function installShellMock(page: Page, openCheckouts: OpenTournamentCheckoutRead[]) {
  await page.route('**/api/v1/**', (route: Route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '')
    if (path === STREAM_PATH) return fulfillParkedStream(route)
    if (path === '/v1/session') return json(route, 200, SESSION)
    if (path === '/v1/notifications/unread-count') {
      return json(route, 200, { unread_count: 0 })
    }
    if (path === '/v1/me/checkouts/open') return json(route, 200, openCheckouts)
    if (path === '/v1/dashboard') return json(route, 200, EMPTY_DASHBOARD)
    const tournamentId = path.match(/^\/v1\/tournaments\/([^/]+)$/)?.[1]
    if (tournamentId) {
      return json(
        route,
        200,
        buildTournamentDetailRead({
          id: tournamentId,
          status: 'published',
          registration_open: true,
          checkout_available: true,
          can_edit: false,
          events: [],
        }),
      )
    }
    if (/\/checkouts\/current$/.test(path)) {
      return json(route, 404, { detail: 'No active checkout.' })
    }
    // Anything else the shell/dashboard happens to fetch on load.
    return json(route, 200, [])
  })
}

const bar = (page: Page) => page.getByRole('region', { name: 'Open checkouts' })
const summary = (page: Page) => page.getByTestId('open-checkout-summary')

test.describe('Open-checkout bar', () => {
  test('one active checkout sits under the header, above `main`, and Resume opens its Events tab', async ({
    page,
  }) => {
    const checkout = buildOpenCheckoutRead({
      tournament_name: 'Spring Open',
      expires_at: new Date(Date.now() + 5 * 60_000 + 5_000).toISOString(),
    })
    await installShellMock(page, [checkout])
    await page.goto('/dashboard')

    await expect(bar(page)).toBeVisible()
    await expect(summary(page)).toHaveText(/^Checkout open · Spring Open · \d\d:\d\d left$/)

    const header = page.locator('.app-shell__topbar')
    const main = page.getByRole('main')
    const [headerBox, barBox, mainBox] = await Promise.all([
      header.boundingBox(),
      bar(page).boundingBox(),
      main.boundingBox(),
    ])
    expect(headerBox).not.toBeNull()
    expect(barBox).not.toBeNull()
    expect(mainBox).not.toBeNull()
    // Under the header…
    expect(barBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height - 1)
    // …and never over `main` — no vertical overlap between the two boxes.
    expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(mainBox!.y + 1)

    await bar(page).getByRole('link', { name: 'Resume' }).click()
    await expect(page).toHaveURL(
      // The checkout id rides along, so a hold past its deadline stays reachable.
      new RegExp(
        `/tournaments/${checkout.tournament_id}\\?tab=events&checkout=${checkout.checkout_id}$`,
      ),
    )
  })

  test('several checkouts: nearest deadline shown, the rest behind "+N more"', async ({
    page,
  }) => {
    const soon = buildOpenCheckoutRead({
      checkout_id: '11111111-1111-4111-8111-111111111111',
      tournament_id: '22222222-2222-4222-8222-222222222222',
      tournament_name: 'Riverside Classic',
      expires_at: new Date(Date.now() + 90_000).toISOString(),
    })
    const later = buildOpenCheckoutRead({
      checkout_id: '33333333-3333-4333-8333-333333333333',
      tournament_id: '44444444-4444-4444-8444-444444444444',
      tournament_name: 'Bay Area Open',
      expires_at: new Date(Date.now() + 8 * 60_000).toISOString(),
    })
    const checking = buildOpenCheckoutRead({
      checkout_id: '55555555-5555-4555-8555-555555555555',
      tournament_id: '66666666-6666-4666-8666-666666666666',
      tournament_name: 'Club Championship',
      payment_state: 'checking',
    })
    await installShellMock(page, [later, checking, soon])
    await page.goto('/dashboard')

    // Nearest real deadline first — never the payment under check, which has
    // none the player can act on.
    await expect(summary(page)).toContainText('Riverside Classic')
    const more = page.getByRole('button', { name: '+2 more' })
    await expect(more).toBeVisible()

    await more.click()
    const list = page.getByRole('list', { name: 'All open checkouts' })
    await expect(list).toBeVisible()
    const items = list.getByRole('listitem')
    await expect(items).toHaveCount(3)
    await expect(items).toContainText([
      'Riverside Classic',
      'Bay Area Open',
      'Club Championship',
    ])
    await expect(list).toContainText('Checking your payment')
  })

  test('is absent on the tournament’s own Events tab, but shown for every other checkout', async ({
    page,
  }) => {
    const here = buildOpenCheckoutRead({
      checkout_id: '77777777-7777-4777-8777-777777777777',
      tournament_id: '88888888-8888-4888-8888-888888888888',
      tournament_name: 'This Very Tournament',
    })
    const elsewhere = buildOpenCheckoutRead({
      checkout_id: '99999999-9999-4999-8999-999999999999',
      tournament_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tournament_name: 'A Different Tournament',
    })
    await installShellMock(page, [here, elsewhere])
    await page.goto(`/tournaments/${here.tournament_id}?tab=events`)

    // The tournament's own checkout is left out…
    await expect(bar(page)).toBeVisible()
    await expect(summary(page)).not.toContainText('This Very Tournament')
    // …but the OTHER one still shows, proving the filter is scoped to this
    // tournament and is not just an empty/broken list.
    await expect(summary(page)).toContainText('A Different Tournament')
  })
})
