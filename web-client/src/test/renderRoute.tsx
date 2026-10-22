import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { act, render } from '@testing-library/react'
import { createAppRouter } from '../router'

// Renders the app's router starting at `path`. The route is loaded before
// rendering. With the default `loadingScreenMs` of 0, this also waits out the
// loading screen, so the page is on screen as soon as this resolves. Pass a
// longer one with fake timers to test the loading screen itself.
export async function renderRoute(
  path: string,
  { loadingScreenMs = 0 }: { loadingScreenMs?: number } = {},
): Promise<void> {
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [path] }),
    { loadingScreenMs },
  )
  await router.load()
  await act(async () => {
    render(<RouterProvider router={router} />)
  })
  if (loadingScreenMs === 0) {
    await act(() => router.options.context.loadingScreenDelay)
  }
}
