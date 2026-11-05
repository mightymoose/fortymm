import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, type RouterHistory } from '@tanstack/react-router'
import { api as defaultApi, type ApiClient } from './api/client'
import { createQueryClient } from './api/queries'
import { routeTree } from './routeTree.gen'
import { createAppUpdate, type AppUpdate } from './serviceWorker'

export function createAppRouter(
  history?: RouterHistory,
  {
    queryClient = createQueryClient(),
    api = defaultApi,
    appUpdate = createAppUpdate(undefined),
  }: { queryClient?: QueryClient; api?: ApiClient; appUpdate?: AppUpdate } = {},
) {
  return createRouter({
    routeTree,
    history,
    context: { api, queryClient, appUpdate },
    // A link loads its route's chunk and runs its loaders when the pointer
    // rests on it or it takes focus, so the click finds them ready.
    defaultPreload: 'intent',
    // TanStack Query caches the data, so the router keeps no preloaded
    // loader data of its own and runs the loaders again on the click.
    defaultPreloadStaleTime: 0,
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}

declare module '@tanstack/history' {
  interface HistoryState {
    // Set by the player review when it goes to Home, so Home moves focus to
    // its title.
    fromReview?: true
    // Set by the scoring page's route when it drops a fragment it can't
    // read, so the page says why its scores start empty.
    discardedScores?: true
  }
}
