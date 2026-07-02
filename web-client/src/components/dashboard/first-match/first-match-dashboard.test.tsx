import { screen } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { render } from '@/test/utilities'

import { FirstMatchDashboard } from './first-match-dashboard'

function renderFirstMatchDashboard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: FirstMatchDashboard,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

// Wiring only: each card's own content and behavior is pinned by its own
// test file (first-match-card, starting-rating-card, no-matches-card).
describe('FirstMatchDashboard', () => {
  it('composes the hero, rating, and empty-matches cards', async () => {
    renderFirstMatchDashboard()

    expect(
      await screen.findByRole('heading', { name: /log your first match/i }),
    ).toBeInTheDocument()
    expect(screen.getByText('1500')).toBeInTheDocument()
    expect(screen.getByText('No matches yet. Go play.')).toBeInTheDocument()
  })
})
