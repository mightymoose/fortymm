import { createFileRoute } from '@tanstack/react-router'
import { zodValidator } from '@tanstack/zod-adapter'

import { matchListQueryOptions } from '@/api/matches'
import { SESSION_QUERY_KEY } from '@/api/session'
import { MatchList } from '@/components/matches/match-list'
import {
  listParamsFromSearch,
  matchesSearchSchema,
} from '@/components/matches/match-list/match-list-status'
import { pageTitle } from '@/lib/page-title'

// Re-exported so existing importers (and any deep-link tests) can keep reading
// the search schema + status keys from the route module.
export {
  matchesSearchSchema,
  STATUS_KEYS,
} from '@/components/matches/match-list/match-list-status'

export const Route = createFileRoute('/matches/')({
  head: () => ({
    meta: [{ title: pageTitle('Matches') }],
  }),
  validateSearch: zodValidator(matchesSearchSchema),
  // The filters live in the URL, so the prefetched list must be keyed by them —
  // expose the search to the loader.
  loaderDeps: ({ search }) => search,
  // Warm the React Query cache without blocking the route transition, so an
  // intent preload makes the click render instantly. Skip the prefetch on a
  // cold direct load where the session isn't resolved yet — firing here would
  // 401 into the error boundary ahead of the component's session-gated query
  // (#144).
  loader: ({ context, deps }) => {
    if (!context.queryClient.getQueryData(SESSION_QUERY_KEY)) return
    void context.queryClient.prefetchQuery(
      matchListQueryOptions(listParamsFromSearch(deps)),
    )
  },
  component: MatchesPage,
})

function MatchesPage() {
  return <MatchList />
}
