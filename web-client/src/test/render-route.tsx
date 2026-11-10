import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render } from '@testing-library/react'
import { createAppRouter } from '../router.ts'

// Mounts the whole app, router included, at `path`, the way a person opening
// that URL would see it. A page object's render() calls it with its own URL:
// the route file, its layout and the router's configuration are all part of
// the screen.
//
// It doesn't wait for the route's loader: what the screen shows while its data
// is on the way is part of the screen too. Finders wait (findBy*).
export function renderRoute(path: string) {
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  return render(<RouterProvider router={router} />)
}
