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
    // what comes next.
    fromReview?: true
    // Set by the scoring page's route when it drops a fragment it can't
    // read, so the page says why its scores start empty.
    discardedScores?: true
  }
}
