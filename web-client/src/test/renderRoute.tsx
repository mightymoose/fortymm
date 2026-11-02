import { QueryClient } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { act, render } from '@testing-library/react'
import { createApiClient } from '../api/client'
import { createAppRouter } from '../router'
import type { AppUpdate } from '../serviceWorker'
import { API_BASE_URL } from './server'

export async function renderRoute(
  path: string,
  { waitForLoad = true, appUpdate }: { waitForLoad?: boolean; appUpdate?: AppUpdate } = {},
): Promise<AppRouter> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const api = createApiClient({ baseUrl: API_BASE_URL })
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: [path] }),
    { queryClient, api, appUpdate },
  )
  if (waitForLoad) await router.load()
  await act(async () => {
    render(<RouterProvider router={router} />)
  })
  return router
}

export type AppRouter = ReturnType<typeof createAppRouter>

// Navigates the way a link would, and waits for the new route to render.
// The app has no links between some pages, so tests go through the router.
export async function navigate(router: AppRouter, to: '/' | '/design-system'): Promise<void> {
  await act(() => router.navigate({ to }))
}
