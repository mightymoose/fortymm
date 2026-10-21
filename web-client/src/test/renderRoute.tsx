import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render } from '@testing-library/react'
import { createAppRouter } from '../router'

// Renders the app's router starting at `path`. The route is loaded before
// rendering, so the page is on screen as soon as this resolves.
export async function renderRoute(path: string): Promise<void> {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }))
  await router.load()
  render(<RouterProvider router={router} />)
}
