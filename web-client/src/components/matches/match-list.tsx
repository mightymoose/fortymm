import { useCallback, useEffect, useMemo } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { z } from 'zod'

import {
  matchesCsvUrl,
  useMatchList,
} from '@/api/matches'
import { useSession } from '@/api/session'
import { AppShell } from '@/components/app-shell'
import { useDebouncedValue } from '@/lib/use-debounced-value'

import { ActionBar } from './match-list/action-bar'
import { FilterRow } from './match-list/filter-row'
import { MatchListTable } from './match-list/match-list-table'
import { PaginationFooter } from './match-list/pagination-footer'
import {
  STATUS_TABS,
  TAB_TO_API,
  PAGE_SIZE,
  listParamsFromSearch,
  matchesSearchSchema,
  type StatusKey,
} from './match-list/match-list-status'
import {
  projectMatchListRow,
  buildFilterTabs,
} from './match-list/match-list-row-view'
import './match-list/match-list.css'

/**
 * The /matches page orchestrator. It owns URL state (filters, status tab,
 * page), the session-gated `useMatchList` query, the search debounce, the
 * out-of-range page clamp, and the projection of raw rows into the
 * presentational view models its children consume — then composes the
 * presentational children (`ActionBar`, `FilterRow`, `MatchListTable`,
 * `PaginationFooter`).
 *
 * No props: it is the wrapper rendered by the thin `/matches` route. It reads
 * the validated URL search via `useSearch({ strict: false })` rather than the
 * Route object, so it never imports the route module (which would close an
 * import cycle: route → MatchList → route).
 */
export const MatchList = () => {
  // `strict: false` reads the active location's validated search without
  // binding to the route's id — so the same component renders under both the
  // real `/matches/` route and the integration test's `/matches` harness, and
  // we avoid importing the Route object (circular-import guard).
  const urlSearch = useSearch({ strict: false }) as z.infer<
    typeof matchesSearchSchema
  >
  const navigate = useNavigate()

  const q = urlSearch.q ?? ''
  const status: 'all' | StatusKey = urlSearch.status ?? 'all'
  const page = urlSearch.page ?? 1

  // Debounce only the text search — tab and pagination clicks aren't a
  // hammer risk and should fire immediately so the table doesn't lag the
  // click by 300ms. The URL still updates synchronously on every change.
  const debouncedQ = useDebouncedValue(q.trim(), 300)
  const apiStatus = status === 'all' ? undefined : TAB_TO_API[status]
  // Built via the same helper the route loader uses, so a hover preload and the
  // live query share one cache key and the click renders from cache.
  const queryParams = useMemo(
    () =>
      listParamsFromSearch({
        status: urlSearch.status,
        q: debouncedQ,
        page: urlSearch.page,
      }),
    [urlSearch.status, debouncedQ, urlSearch.page],
  )
  // Wait for the session before firing the matches query — otherwise a
  // first-visit direct-load races the session cookie and 401s into the error
  // boundary (#144). A disabled query stays `isPending`, so the skeleton holds
  // until the session resolves rather than flashing the empty state.
  const session = useSession()
  const matchList = useMatchList(queryParams, { enabled: session.isSuccess })
  const data = matchList.data
  const isLoading = matchList.isPending
  const isFetching = matchList.isFetching

  // Rewrite the URL — `replace: true` keeps each keystroke from filling
  // browser history. Defaults are stripped so the URL stays clean.
  const setSearch = useCallback(
    (patch: Partial<z.infer<typeof matchesSearchSchema>>) => {
      void navigate({
        to: '/matches',
        replace: true,
        search: (prev) => {
          const merged = { ...prev, ...patch }
          return {
            q: merged.q && merged.q.length > 0 ? merged.q : undefined,
            status: merged.status,
            page: merged.page && merged.page > 1 ? merged.page : undefined,
          }
        },
      })
    },
    [navigate],
  )

  const changeStatus = useCallback(
    (next: 'all' | StatusKey) => {
      setSearch({
        status: next === 'all' ? undefined : next,
        page: undefined,
      })
    },
    [setSearch],
  )
  const changeQuery = useCallback(
    (next: string) => {
      setSearch({ q: next || undefined, page: undefined })
    },
    [setSearch],
  )
  const onClear = useCallback(() => {
    setSearch({ q: undefined, status: undefined, page: undefined })
  }, [setSearch])
  const setPage = useCallback(
    (next: number) => {
      setSearch({ page: next })
    },
    [setSearch],
  )

  // CSV reflects what the user just typed (live, not debounced) — clicking
  // Export right after typing should download the query you see, not the
  // stale one the table is still showing.
  const exportHref = useMemo(
    () =>
      matchesCsvUrl({
        status: apiStatus,
        q: q.trim() || undefined,
      }),
    [apiStatus, q],
  )

  const total = data?.total ?? 0
  // True-live only: the server splits posted-but-unconfirmed results out of the
  // `in_progress` count into `awaiting_confirmation_count`, so this no longer
  // folds awaiting-confirmation matches into the Live headline (issue #381).
  const liveCount = data?.status_counts?.in_progress ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // Snap an out-of-range `?page=` back to the last valid page once the real
  // total is known — a stale bookmark or paging past the end would otherwise
  // render an empty table under a nonsensical "Showing 26–16 of 16" footer
  // (#541). Only act on a settled, current total: `isLoading` covers the
  // pending/session-gated window (where `total` is still 0), and `isFetching`
  // covers a `keepPreviousData` refetch still serving the prior filter's total.
  useEffect(() => {
    if (!isLoading && !isFetching && page > totalPages) {
      setPage(totalPages)
    }
  }, [isLoading, isFetching, page, totalPages, setPage])

  // The redirect runs in an effect, so an out-of-range page paints for one
  // frame first. Clamp the page the footer renders with so its range math never
  // shows start > end during that frame.
  const displayPage = Math.min(page, totalPages)

  // Project the raw payload rows into the presentational view models the table
  // consumes — perspective, status tone, side labels, short id, and the
  // relative "started" label all resolve here, never inside the children.
  const rowViews = useMemo(
    () => (data?.items ?? []).map((row) => projectMatchListRow(row)),
    [data?.items],
  )
  const tabs = useMemo(
    () =>
      buildFilterTabs(
        STATUS_TABS,
        data?.status_counts,
        TAB_TO_API,
        data?.awaiting_confirmation_count,
      ),
    [data?.status_counts, data?.awaiting_confirmation_count],
  )

  return (
    <AppShell>
      <div className="match-list-page">
        <ActionBar liveCount={liveCount} exportHref={exportHref} />
        <FilterRow
          q={q}
          setQ={changeQuery}
          status={status}
          setStatus={changeStatus}
          tabs={tabs}
        />
        <div className="table-wrap">
          <MatchListTable
            rows={rowViews}
            isLoading={isLoading}
            onClear={onClear}
            navigate={navigate}
          />
        </div>
        <PaginationFooter
          page={displayPage}
          setPage={setPage}
          total={total}
          pageSize={PAGE_SIZE}
          totalPages={totalPages}
        />
      </div>
    </AppShell>
  )
}
