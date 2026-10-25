import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRouter, type RouterHistory } from '@tanstack/react-router'
import { api as defaultApi, type ApiClient } from './api/client'
import { createQueryClient } from './api/queries'
import { routeTree } from './routeTree.gen'

// Builds the app's router. Tests pass a memory history to start on a given
// path, a QueryClient that doesn't retry, and an API client with a stub
// fetch. The app uses the browser history and the defaults.
export function createAppRouter(
  history?: RouterHistory,
  {
    queryClient = createQueryClient(),
    api = defaultApi,
  }: { queryClient?: QueryClient; api?: ApiClient } = {},
) {
  return createRouter({
    routeTree,
    history,
    context: { api, queryClient },
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
