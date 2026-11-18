import {
  createBrowserHistory,
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
  type RouterHistory,
} from '@tanstack/react-router'
import { render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { onTestFinished } from 'vitest'

// Mounts one screen component from src/components/, with the props the test
// gives it, and none of the app's routes: no route file, no loader, no URL to
// match. A component test's page object calls it from render(props).
//
// The screen still gets a router of its own, a bare one whose only route
// renders it, because a <Link> or <Await> needs one to render. Nothing about
// that router is under test; src/test/render-route.tsx mounts the app's.
//
// The router's address is `/` unless the test gives a `path`: a component
// whose <Link>s mark the current page (the sidebar, the design system
// page's tabs) is rendered at the page the test wants current. It follows a
// link the test clicks: the screen stays, at the link's address.
//
// With `browserHistory`, the router keeps its address in jsdom's own
// window.history instead of in memory, as it does in the app: only then does
// a screen's leave guard answer the window's `beforeunload` (closing or
// reloading the tab). It stops listening when the test ends.
export function renderScreen(
  screen: ReactNode,
  { path = '/', browserHistory = false } = {},
) {
  let history: RouterHistory
  if (browserHistory) {
    window.history.replaceState(null, '', path)
    const browser = createBrowserHistory()
    onTestFinished(() => browser.destroy())
    history = browser
  } else {
    history = createMemoryHistory({ initialEntries: [path] })
  }
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => screen,
      notFoundComponent: () => null,
    }),
    history,
  })
  return render(<RouterProvider router={router} />)
}
