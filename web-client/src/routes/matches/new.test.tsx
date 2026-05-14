import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { components } from '@/api/schema'
import { server } from '@/mocks/server'
import { Route } from './new'

type MatchRead = components['schemas']['MatchRead']

// The page component isn't exported (route files should only export `Route`,
// so the router plugin can code-split them) — pull it off the route instead.
const NewMatchPage = Route.options.component!

function pendingMatch(): MatchRead {
  return {
    id: 'm-test',
    status: 'pending',
    created_by_user_id: 'u-test',
    created_at: '2026-05-14T00:00:00Z',
    settings: {
      team_size: 1,
      best_of: 5,
      affects_rating: false,
      verification_policy: 'none',
    },
    sides: [],
  }
}

// NewMatchPage navigates to /dashboard on success, so the test router needs
// both routes mounted.
function renderNewMatch() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const newMatchRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/matches/new',
    component: NewMatchPage,
  })
  const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/dashboard',
    component: () => <div>Dashboard route</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([newMatchRoute, dashboardRoute]),
    history: createMemoryHistory({ initialEntries: ['/matches/new'] }),
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('NewMatchPage', () => {
  it('blocks a rated match with no opponent and shows an inline error', async () => {
    const user = userEvent.setup()
    renderNewMatch()

    // Rated is on by default and no opponent is picked yet.
    await user.click(
      await screen.findByRole('button', { name: /start match/i }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /rated match needs an opponent/i,
    )
    // Still on the match page — nothing was submitted.
    expect(
      screen.getByRole('heading', { level: 1, name: /new match/i }),
    ).toBeInTheDocument()
  })

  it('creates a match against a picked opponent and navigates to the dashboard', async () => {
    const user = userEvent.setup()
    let captured: unknown = null
    server.use(
      http.get('*/v1/players', () =>
        HttpResponse.json([
          { id: 'pl-1', username: 'ada.lovelace' },
          { id: 'pl-2', username: 'grace.hopper' },
        ]),
      ),
      http.post('*/v1/matches', async ({ request }) => {
        captured = await request.json()
        return HttpResponse.json(pendingMatch(), { status: 201 })
      }),
    )
    renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /ada\.lovelace/i }),
    )
    await user.click(screen.getByRole('button', { name: /start match/i }))

    await waitFor(() =>
      expect(screen.getByText('Dashboard route')).toBeInTheDocument(),
    )
    expect(captured).toEqual({
      opponent_user_id: 'pl-1',
      best_of: 5,
      rated: true,
    })
  })

  it('starts a single-sided unrated match when no opponent is chosen', async () => {
    const user = userEvent.setup()
    let captured: unknown = null
    server.use(
      http.post('*/v1/matches', async ({ request }) => {
        captured = await request.json()
        return HttpResponse.json(pendingMatch(), { status: 201 })
      }),
    )
    renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /start without opponent/i }),
    )
    await user.click(screen.getByRole('button', { name: /start match/i }))

    await waitFor(() =>
      expect(screen.getByText('Dashboard route')).toBeInTheDocument(),
    )
    // Guest / TBD opponents can't be rated, so `rated` is forced false.
    expect(captured).toEqual({
      opponent_user_id: null,
      best_of: 5,
      rated: false,
    })
  })

  it('surfaces the API error detail when match creation fails', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('*/v1/players', () =>
        HttpResponse.json([{ id: 'pl-1', username: 'ada.lovelace' }]),
      ),
      http.post('*/v1/matches', () =>
        HttpResponse.json(
          { detail: 'opponent not found' },
          { status: 404 },
        ),
      ),
    )
    renderNewMatch()

    await user.click(
      await screen.findByRole('button', { name: /ada\.lovelace/i }),
    )
    await user.click(screen.getByRole('button', { name: /start match/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /opponent not found/i,
    )
  })
})
