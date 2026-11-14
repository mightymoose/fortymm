import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'

// Mounts one screen component from src/components/, with the props the test
// gives it, and none of the app's routes: no route file, no loader, no URL to
// match. A component test's page object calls it from render(props).
//
// The screen still gets a router of its own, a bare one whose only route
// renders it, because a <Link> or <Await> needs one to render. Nothing about
// that router is under test; src/test/render-route.tsx mounts the app's.
export function renderScreen(screen: ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => screen }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(<RouterProvider router={router} />)
}
