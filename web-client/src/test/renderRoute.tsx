import { QueryClient } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { act, render } from '@testing-library/react'
import { createApiClient } from '../api/client'
import { sessionQuery } from '../api/queries'
import { createAppRouter } from '../router'
import { API_BASE_URL } from './server'

// Renders the app's router starting at `path`, against the mock API in
// ./server.ts, and returns the router. The route is loaded before rendering.
// By default this also waits for the session. The mock API answers it before
// the loading screen would show, so the page is on screen as soon as this
// resolves. Pass `waitForSession: false` to test the loading screen.
export async function renderRoute(
  path: string,
  { waitForSession = true }: { waitForSession?: boolean } = {},
): Promise<AppRouter> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const api = createApiClient({ baseUrl: API_BASE_URL })
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [path] }),
    { queryClient, api },
  )
  await router.load()
  await act(async () => {
    render(<RouterProvider router={router} />)
  })
  if (waitForSession) {
    await act(() => queryClient.ensureQueryData(sessionQuery(api)))
  }
  return router
}

export type AppRouter = ReturnType<typeof createAppRouter>

// Navigates the way a link would, and waits for the new route to render.
// The app has no links between some pages, so tests go through the router.
export async function navigate(router: AppRouter, to: '/' | '/design-system'): Promise<void> {
  await act(() => router.navigate({ to }))
}
