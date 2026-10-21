import {
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from '@tanstack/react-router'
import { DesignSystem } from './routes/DesignSystem'
import { Home } from './routes/Home'
import { Root } from './routes/Root'

const rootRoute = createRootRoute({ component: Root })

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
// path; the app uses the default browser history.
export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree, history })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
