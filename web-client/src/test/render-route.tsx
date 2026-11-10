import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { createAppRouter } from '../router.ts'

// Mounts the whole app, router included, at `path`, the way a person opening
// that URL would see it. Use it for every screen test: the route file, its
// layout and the router's configuration are all part of the screen.
export async function renderRoute(path: string) {
  const router = createAppRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  // Resolve the matched route (and its code-split chunk) before rendering.
  await router.load()
  const user = userEvent.setup()
  const result = render(<RouterProvider router={router} />)
  return { ...result, router, user }
}
