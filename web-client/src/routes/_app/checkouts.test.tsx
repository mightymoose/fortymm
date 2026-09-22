import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { vi } from 'vitest'

import { server } from '@/mocks/server'
import { render, screen } from '@/test/utilities'

async function renderCheckouts() {
  const { Route } = await import('./checkouts')
  const CheckoutsPage = Route.options.component!
  const rootRoute = createRootRoute()
  const checkoutsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/checkouts',
    component: CheckoutsPage,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([checkoutsRoute]),
    history: createMemoryHistory({ initialEntries: ['/checkouts'] }),
  })
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

it('shows a retryable error instead of an empty checkout list when loading fails', async () => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  let requests = 0
  server.use(
    http.get('*/v1/checkouts', () => {
      requests += 1
      return requests === 1
        ? HttpResponse.json(
            { detail: 'Checkout service unavailable.' },
            { status: 503 },
          )
        : HttpResponse.json({ items: [] })
    }),
  )

  await renderCheckouts()

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent(/load.*checkouts|checkouts.*unavailable/i)
  expect(
    screen.queryByText('You have no checkouts that need attention.'),
  ).toBeNull()

  await userEvent.click(screen.getByRole('button', { name: /^retry$/i }))

  expect(
    await screen.findByText('You have no checkouts that need attention.'),
  ).toBeInTheDocument()
  expect(requests).toBe(2)
})
