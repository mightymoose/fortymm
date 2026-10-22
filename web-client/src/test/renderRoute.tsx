import { QueryClient } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createApiClient } from '../api/client'
import { healthQuery } from '../api/queries'
import { createAppRouter } from '../router'
import { API_BASE_URL } from './server'

// Renders the app's router starting at `path`, against the mock API in
// ./server.ts. The route is loaded before rendering. By default this also
// waits for the health check and the loading screen's fade-out, so the page
// is on screen as soon as this resolves. Pass `waitForHealth: false` to test
// the loading screen.
export async function renderRoute(
  path: string,
  { waitForHealth = true }: { waitForHealth?: boolean } = {},
): Promise<void> {
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
  if (waitForHealth) {
    await act(() => queryClient.ensureQueryData(healthQuery(api)))
    // jsdom runs no CSS animations, so end the loading screen's fade-out.
    fireEvent.animationEnd(
      screen.getByRole('status', { name: 'Loading FortyMM' }),
    )
  }
}
