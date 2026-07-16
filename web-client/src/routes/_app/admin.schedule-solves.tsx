import { createFileRoute } from '@tanstack/react-router'
import { zodValidator } from '@tanstack/zod-adapter'

import { SESSION_QUERY_KEY } from '@/api/session'
import {
  SolveLedgerPage,
  SolveLedgerSkeleton,
} from '@/components/scheduling/solve-ledger-page'
import {
  adminScheduleSolvesQueryOptions,
  solveLedgerSearchSchema,
} from '@/components/scheduling/queries'
import { pageTitle } from '@/lib/page-title'

/**
 * The Administration area's solve-ledger page (ADR "the schedule is solved;
 * the call is pinned": "the admin page reads it verbatim").
 *
 * Gating follows the other admin surfaces exactly: the server enforces
 * `scheduling.view` on the page's one endpoint, the query's 403 trips the
 * admin layout's `RbacBoundary`, and the boundary renders the designed
 * access-denied panel. Suspense owns loading (`pendingComponent` is the
 * layout-matched skeleton); the boundary owns errors and its reset retries.
 */
export const Route = createFileRoute('/_app/admin/schedule-solves')({
  head: () => ({
    meta: [{ title: pageTitle('Scheduling · Admin') }],
  }),
  validateSearch: zodValidator(solveLedgerSearchSchema),
  // The filter + page live in the URL, so the prefetched ledger must be keyed
  // by them — expose the search to the loader.
  loaderDeps: ({ search }) => search,
  // Warm the React Query cache without blocking the route transition, so an
  // intent preload makes the click render instantly. Skip the prefetch on a
  // cold direct load where the session isn't resolved yet — firing here would
  // race the session cookie (the `/players` pattern); the component's
  // suspense query fires after the `_app` loader has established it.
  loader: ({ context, deps }) => {
    if (!context.queryClient.getQueryData(SESSION_QUERY_KEY)) return
    void context.queryClient.prefetchQuery(
      adminScheduleSolvesQueryOptions({
        page: deps.page ?? 1,
        tournamentId: deps.tournament,
      }),
    )
  },
  pendingComponent: SolveLedgerSkeleton,
  component: SolveLedgerRoute,
})

function SolveLedgerRoute() {
  const search = Route.useSearch()
  return <SolveLedgerPage page={search.page ?? 1} tournamentId={search.tournament} />
}
