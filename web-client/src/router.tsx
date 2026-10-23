import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type RouterHistory,
} from '@tanstack/react-router'
import { AuthenticatedLayout } from './routes/AuthenticatedLayout'
import { DesignSystem } from './routes/DesignSystem'
import { Home } from './routes/Home'
import { Root } from './routes/Root'

export const LOADING_SCREEN_MS = 3000

export type RouterContext = {
  // Resolves once the loading screen has shown for long enough.
  // AuthenticatedLayout suspends on it, so its pages show the loading screen
  // first. Pages outside it, like the design system, show at once.
  loadingScreenDelay: Promise<void>
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Root,
})

// A pathless layout route: it adds no path segment to the pages under it.
const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authenticated',
  component: AuthenticatedLayout,
})

const homeRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: '/',
  component: Home,
})

const designSystemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/design-system',
  component: DesignSystem,
})

const routeTree = rootRoute.addChildren([
  authenticatedRoute.addChildren([homeRoute]),
  designSystemRoute,
])

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Builds the app's router. Tests pass a memory history to start on a given
// path, and a shorter loading screen; the app uses the default browser
// history and LOADING_SCREEN_MS. The delay starts here, once per page load.
export function createAppRouter(
  history?: RouterHistory,
  { loadingScreenMs = LOADING_SCREEN_MS }: { loadingScreenMs?: number } = {},
) {
  return createRouter({
    routeTree,
    history,
    context: { loadingScreenDelay: delay(loadingScreenMs) },
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
