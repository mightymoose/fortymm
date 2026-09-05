import { stubUnreadNotifications } from '../../support/notifications'
import type { Locator, Page } from '@playwright/test'
import type { components } from '../../../src/api/schema'
import { PERM } from '../../../src/lib/permissions'
import {
  buildAdminScheduleSolveRead,
  pageAdminScheduleSolves,
} from '../../../src/mocks/factories/tournaments/tournament.factory'
import { sessionResponse } from '../../../src/test/factories'
import { stubRealtimeStream } from '../../support/realtime'

type AdminScheduleSolveRead = components['schemas']['AdminScheduleSolveRead']

export { buildAdminScheduleSolveRead }

/** 26 succeeded runs, newest first, over two tournaments — one more than a
 * page, so page 2 exists and holds exactly one row (small fixtures hide
 * acceptance bugs), with the interesting shapes carved into the newest rows so
 * they render on page 1. */
export function buildLedgerSeed(): AdminScheduleSolveRead[] {
  const rows = Array.from({ length: 26 }, (_, i) =>
    buildAdminScheduleSolveRead({
      id: `solve-${i + 1}`,
      requested_at: `2026-07-15T10:${String(59 - i).padStart(2, '0')}:00Z`,
      tournament_id: i % 2 === 0 ? 'bay-area-open-2026' : 'summer-slam-2026',
      tournament_name: i % 2 === 0 ? 'Bay Area Open 2026' : 'Summer Slam 2026',
    }),
  )
  rows[0] = {
    ...rows[0],
    status: 'failed',
    verdict: null,
    wall_time_ms: null,
    fixtures_placed: null,
    fixtures_pinned: null,
    error: 'worker crashed: out of memory in CP-SAT presolve',
    input_fingerprint: 'deadbeef'.repeat(8),
  }
  rows[1] = {
    ...rows[1],
    status: 'running',
    verdict: null,
    finished_at: null,
    wall_time_ms: null,
    fixtures_placed: null,
    fixtures_pinned: null,
    rerun_requested: true,
  }
  return rows
}

/**
 * Page object for the admin solve-ledger page (`/admin/schedule-solves`),
 * MSW OFF: the session and the page's one endpoint are stubbed with inline
 * `page.route` interceptors, and paging/filtering go through the same
 * `pageAdminScheduleSolves` helper the dev-world MSW handler uses — one
 * implementation of the endpoint's query contract, not two drifting ones.
 */
export class SolveLedgerPage {
  static async navigateTo(
    page: Page,
    options: {
      rows?: AdminScheduleSolveRead[]
      /** Session grants. Default: an operator who can see the ledger. */
      permissions?: string[]
      /** Answer the endpoint with the server-side permission 403 instead of
       * rows — the `scheduling.view` gate, raw FastAPI detail and all. */
      forbidden?: boolean
      path?: string
    } = {},
  ): Promise<SolveLedgerPage> {
    const pom = new SolveLedgerPage(page)
    const rows = options.rows ?? buildLedgerSeed()

    // `_app` opens a realtime stream alongside the session bootstrap; this
    // suite has no catch-all, so it needs its own stub (`../../support/realtime`).
    await stubRealtimeStream(page)
    await stubUnreadNotifications(page)

    await page.route('**/v1/session', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          sessionResponse({
            user: {
              username: 'rita.kovac',
              permissions: options.permissions ?? [
                PERM.ADMIN_VIEW,
                PERM.SCHEDULING_VIEW,
              ],
            },
          }),
        ),
      }),
    )

    await page.route('**/v1/admin/schedule-solves*', (route) => {
      if (options.forbidden) {
        return route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'Missing permission: scheduling.view' }),
        })
      }
      const url = new URL(route.request().url())
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          pageAdminScheduleSolves(rows, {
            tournament_id: url.searchParams.get('tournament_id'),
            page: Number(url.searchParams.get('page') ?? '1'),
            page_size: Number(url.searchParams.get('page_size') ?? '25'),
          }),
        ),
      })
    })

    await page.goto(options.path ?? '/admin/schedule-solves')
    return pom
  }

  constructor(public readonly page: Page) {}

  row(id: string): Locator {
    return this.page.getByTestId(`solve-row-${id}`)
  }
  detail(id: string): Locator {
    return this.page.getByTestId(`solve-detail-${id}`)
  }
  detailsToggle(id: string): Locator {
    return this.row(id).getByRole('button', { name: /run details/ })
  }
  get filterChip(): Locator {
    return this.page.getByTestId('tournament-filter-chip')
  }
  get readout(): Locator {
    return this.page.locator('.footer-info')
  }
  get nextPage(): Locator {
    return this.page.getByRole('button', { name: 'Next page' })
  }
  get emptyState(): Locator {
    return this.page.getByText('No solver runs yet')
  }
  get accessDenied(): Locator {
    return this.page.getByText("You don't have access to this page")
  }
}
