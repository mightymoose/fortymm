import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { render } from './utilities'

export interface RenderWithRoutesOptions {
  /**
   * The route paths any typed `<Link>` in the tree navigates to. Each is
   * registered as a stub route so the link resolves at render — an unregistered
   * target throws.
   */
  linkTargets?: string[]
  /** The path the component under test is mounted at. */
  path?: string
}

/**
 * Render a component that contains typed TanStack `<Link>`s under a minimal
 * memory router.
 *
 * A `<Link>` needs a `RouterProvider` whose route tree registers its target, so
 * every page object mounting a link-bearing component needs this harness (the
 * pattern `game-grid-cell.page.tsx` established, hoisted here rather than pasted
 * a fourth time). The router resolves **asynchronously**, so tests against such
 * a component must start with an `await find…()`.
 *
 * Goes through `@/test/utilities`' `render`, so the tree is also wrapped in a
 * fresh, retry-free `QueryClient`.
 */
export function renderWithRoutes(
  ui: ReactNode,
  { linkTargets = [], path = '/' }: RenderWithRoutesOptions = {},
) {
  const rootRoute = createRootRoute()
  const hostRoute = createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => <>{ui}</>,
  })
  const targetRoutes = linkTargets.map((target) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: target,
      component: () => <div>{target}</div>,
    }),
  )
  const router = createRouter({
    routeTree: rootRoute.addChildren([hostRoute, ...targetRoutes]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })

  return render(<RouterProvider router={router} />)
}
