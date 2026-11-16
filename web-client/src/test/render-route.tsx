import {
  createBrowserHistory,
  createMemoryHistory,
  RouterProvider,
  type RouterHistory,
} from '@tanstack/react-router'
import { render } from '@testing-library/react'
import { onTestFinished } from 'vitest'
import { createAppRouter } from '../router.ts'

// Mounts the whole app, router included, at `path`, the way a person opening
// that URL would see it. A page object's render() calls it with its own URL:
// the route file, its layout and the router's configuration are all part of
// the screen.
//
// It doesn't wait for the route's loader: what the screen shows while its data
// is on the way is part of the screen too. Finders wait (findBy*).
//
// It gives the router too, for a test of where a redirect ends:
// router.state.location.pathname.
//
// With `browserHistory`, the router keeps its address in jsdom's own
// window.history, as in the app: the browser's Back goes through popstate
// and the screens' leave guards, as in a browser. It stops listening when
// the test ends.
export function renderRoute(path: string, { browserHistory = false } = {}) {
  let history: RouterHistory
  if (browserHistory) {
    window.history.replaceState(null, '', path)
    const browser = createBrowserHistory()
    onTestFinished(() => browser.destroy())
    history = browser
  } else {
    history = createMemoryHistory({ initialEntries: [path] })
  }
  const router = createAppRouter({ history })
  return { ...render(<RouterProvider router={router} />), router }
}
