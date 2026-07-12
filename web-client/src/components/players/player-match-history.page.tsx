import { useCallback, useState } from 'react'
import { HttpResponse } from 'msw'

import type { components } from '@/api/schema'
import {
  mockPlayerMatchesEndpoint,
  type PlayerMatchesResolver,
} from '@/mocks/endpoints/players/player-matches.endpoint'
import { server } from '@/mocks/server'
import { renderWithRoutes } from '@/test/router'
import { screen, type Container } from '@/test/utilities'
import { paginationFooterPage } from '@/components/pagination-footer.page'

import {
  PlayerMatchHistory,
  type PlayerMatchHistoryProps,
} from './player-match-history'
import {
  HISTORY_PAGE_SIZE,
  buildPlayerMatchHistoryProps,
  buildPlayerMatchPage,
} from './player-match-history.factory'

type PlayerMatchRow = components['schemas']['PlayerMatchRow']

/** The route the "Back to profile" link opens. Registered as a stub so the
 * typed `<Link>` resolves. */
export const PLAYER_PROFILE_ROUTE = '/players/$userId'

/** The pages the table actually asked the API for, in order — so a test can
 * prove the pager fetched page 2 rather than re-sliced page 1 in the client. */
export interface MatchesRequestLog {
  pages: number[]
  pageSizes: number[]
}

/** The body rows of whichever table is up — `query`, not `get`, because the
 * empty and error states render no table at all and "no rows" is a legitimate
 * answer there rather than a test failure. */
const rowsIn = (container: Container): HTMLElement[] =>
  container
    .queryAllByRole('row')
    .filter((row: HTMLElement) => row.querySelector('td') !== null)

const scoped = (container: Container) => ({
  /** The page heading, "{username} · Match history". Absent while the profile
   * bundle is pending — a skeleton stands in its place. */
  findTitle() {
    return container.findByRole('heading', { level: 1 })
  },
  queryTitle() {
    return container.queryByRole('heading', { level: 1 })
  },
  /** The skeleton the heading shows while the player is still resolving. */
  queryTitleSkeleton() {
    return container.queryByLabelText('Loading player')
  },
  /** "Back to profile" — the only navigation off this page. */
  getBackLink() {
    return container.getByRole('link', { name: /back to profile/i })
  },

  /** The match rows, `<thead>` excluded. Empty while the skeleton is up: its
   * placeholder rows are `aria-hidden`. */
  getRows(): HTMLElement[] {
    return rowsIn(container)
  },
  /** Every opponent name in the table, top to bottom. The solo sentinel row
   * reads "No opponent". */
  getOpponentNames(): string[] {
    return rowsIn(container).map(
      (row) => row.querySelector('.player-name')?.textContent ?? '',
    )
  },
  /** The result chips in the table, top to bottom — WIN / LOSS / LIVE /
   * AWAITING / UP NEXT / VOIDED. */
  getResultChips(): string[] {
    return rowsIn(container).map(
      (row) =>
        row.querySelector('.player-profile__result-chip')?.textContent ?? '',
    )
  },
  /** The loading skeleton — the same `<table aria-busy>` for both the
   * player-pending and the matches-pending windows. */
  queryLoadingTable() {
    return container.queryByRole('table', { busy: true })
  },
  /** The designed empty state, for a player with no matches at all. */
  queryEmptyState() {
    return container.queryByText('No matches yet')
  },
  /** The inline failure state — the table's own, not the route boundary's. */
  queryError() {
    return container.queryByRole('alert')
  },
  findError() {
    return container.findByRole('alert')
  },
  getRetryButton() {
    return container.getByRole('button', { name: /try again/i })
  },

  /**
   * The whole "Matches" section header, whitespace-normalized. Reads exactly
   * `"Matches"` — the bare count chip that used to sit beside the title is gone,
   * the footer's readout being the page's one count (#1006). Asserting on the
   * header's *text* rather than on the chip's class keeps this honest if the
   * chip ever comes back wearing a different name.
   */
  getSectionHeaderText(): string {
    const header = container
      .getByText('Matches')
      .closest('.player-profile__section-header')
    return (header?.textContent ?? '').replace(/\s+/g, ' ').trim()
  },

  /**
   * Every element on the page whose entire text is `total` — i.e. everywhere the
   * page prints the count. Exactly one (the footer's `<span class="mono">`) since
   * #1006; two before it, the header chip having said the same number a second
   * time. The footer's range span reads "1–2", not "2", so it is not a match.
   */
  getCountReadouts(total: number): HTMLElement[] {
    return container.queryAllByText(String(total))
  },

  /**
   * The footer's readout, whitespace-normalized: "Showing 26–26 of 26 matches".
   * `null` when the footer is not rendered **at all** — which is what
   * `paginationFooterPage.getInfo()` cannot express (it throws).
   *
   * Since #1006 the footer renders at every row count **above zero**, so a `null`
   * here is a regression of that fix — *unless* the history is genuinely empty,
   * the one case that renders the empty state alone (see `queryPagerButtons`).
   */
  queryFooterSummary(): string | null {
    const info = container.queryByText(/showing/i)
    return info?.textContent?.replace(/\s+/g, ' ').trim() ?? null
  },

  /**
   * The pager's four chevron controls — first / previous / next / last.
   *
   * `queryAll`, so "there is no pager" is expressible: at zero matches the whole
   * footer is absent, and the shared footer's page object can only `get*` them
   * (it throws). Disabled buttons still match — being *present but dead* is what
   * this distinguishes an empty history from.
   */
  queryPagerButtons(): HTMLElement[] {
    return container.queryAllByRole('button', {
      name: /(first|previous|next|last) page/i,
    })
  },
  /** The pager itself — `getNextPageButton`, `getPageLink(n)`, … — reused from
   * the shared footer's own page object rather than re-derived here. */
  ...paginationFooterPage.within(container),
})

/**
 * Test page-object for `PlayerMatchHistory` — the full, paginated match-history
 * page behind `/players/$userId/matches`.
 *
 * Two things it supplies that the component needs and does not own:
 *
 * - a **router** (its "Back to profile" `<Link>` is typed, and resolves
 *   asynchronously — start tests with `await playerMatchHistoryPage.findTitle()`
 *   or another `find`/`waitFor`);
 * - the **page state**, which in production lives in the URL (see
 *   `RoutedPlayerMatchHistory`), so clicking the pager really re-fetches.
 *
 * The table fetches `GET /v1/players/:id/matches` itself, so every test must
 * stub it: `mockMatches(rows)` serves the list a page at a time, exactly as the
 * API does.
 */
export const playerMatchHistoryPage = {
  /**
   * Stub the matches endpoint with a **real pager** over `rows`: it reads
   * `?page` / `?page_size` off the request and answers with that slice plus the
   * full total — so page 2 of a 26-row history returns the 26th row and a total
   * of 26, not a re-run of page 1.
   *
   * Returns the request log, so a test can assert the pager actually went back
   * to the server for page 2.
   */
  mockMatches(rows: PlayerMatchRow[]): MatchesRequestLog {
    const log: MatchesRequestLog = { pages: [], pageSizes: [] }
    mockPlayerMatchesEndpoint(server, ({ request }) => {
      const params = new URL(request.url).searchParams
      const page = Number(params.get('page') ?? '1')
      const pageSize = Number(params.get('page_size') ?? String(HISTORY_PAGE_SIZE))
      log.pages.push(page)
      log.pageSizes.push(pageSize)
      return HttpResponse.json(buildPlayerMatchPage(rows, { page, pageSize }))
    })
    return log
  },

  /** Stub the matches endpoint with an arbitrary resolver — for the failure and
   * retry paths. */
  mockMatchesEndpoint(resolver: PlayerMatchesResolver) {
    mockPlayerMatchesEndpoint(server, resolver)
  },

  /**
   * Mount the page. The `page` override is the page the harness *starts* on.
   *
   * The `page` / `onPageChange` pair is a **controlled** one: in production the
   * route owns it, because the page number lives in the URL. A harness that held
   * `page` fixed could never click "Next" and see page 2 — so this stands in for
   * the route, keeping the page in state and still forwarding every change to
   * whatever `onPageChange` the test passed (so a spy can observe the redirect
   * the out-of-range effect fires).
   */
  render(overrides: Partial<PlayerMatchHistoryProps> = {}) {
    const { page: initialPage, onPageChange, ...rest } =
      buildPlayerMatchHistoryProps(overrides)

    // Local component (not module-level) so this file still exports only the
    // page object, keeping fast-refresh's lint rule happy — the same shape
    // `opponent-typeahead.page.tsx` uses.
    const RoutedHistory = () => {
      const [page, setPage] = useState(initialPage)
      // `onPageChange` is an outer-scope value (a `render()` argument), so it is
      // stable for the life of this mount and is not a valid dependency.
      const handlePageChange = useCallback((next: number) => {
        setPage(next)
        onPageChange(next)
      }, [])
      return (
        <PlayerMatchHistory
          {...rest}
          page={page}
          onPageChange={handlePageChange}
        />
      )
    }

    renderWithRoutes(<RoutedHistory />, { linkTargets: [PLAYER_PROFILE_ROUTE] })
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
