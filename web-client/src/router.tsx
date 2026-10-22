import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type RouterHistory,
} from '@tanstack/react-router'
import { DesignSystem } from './routes/DesignSystem'
import { Home } from './routes/Home'
import { Root } from './routes/Root'

export const LOADING_SCREEN_MS = 3000

export type RouterContext = {
  // Resolves once the loading screen has shown for long enough. The layout
  // suspends on it, so Root's Suspense boundary shows the loading screen.
  loadingScreenDelay: Promise<void>
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
