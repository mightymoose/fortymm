import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type RouterHistory,
} from '@tanstack/react-router'
import { api as defaultApi, type ApiClient } from './api/client'
import { DesignSystem } from './routes/DesignSystem'
import { Home } from './routes/Home'
import { Root } from './routes/Root'

export type RouterContext = {
  api: ApiClient
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Root,
})

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Home,
})

const designSystemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/design-system',
  component: DesignSystem,
})

const routeTree = rootRoute.addChildren([homeRoute, designSystemRoute])

// Builds the app's router. Tests pass a memory history to start on a given
// path, a QueryClient that doesn't retry, and an API client with a stub
// fetch. The app uses the browser history and the defaults.
export function createAppRouter(
  history?: RouterHistory,
  {
    queryClient = new QueryClient(),
    api = defaultApi,
  }: { queryClient?: QueryClient; api?: ApiClient } = {},
) {
  return createRouter({
    routeTree,
    history,
    context: { api },
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
