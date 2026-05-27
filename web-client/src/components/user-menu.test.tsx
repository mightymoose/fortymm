import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse, delay } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '@/mocks/server'
import { mockSession } from '@/mocks/handlers'
import type { components } from '@/api/schema'
import { UserMenu } from './user-menu'

type SessionResponse = components['schemas']['SessionResponse']

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <>{ui}</>,
  })
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: () => <div>Settings page</div>,
  })
  const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/dashboard',
    component: () => <div>Dashboard page</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      settingsRoute,
      dashboardRoute,
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('UserMenu', () => {
  it('shows a loading skeleton while the session is fetching', async () => {
    server.use(
      http.get('*/v1/session', async () => {
        await delay(100)
        return HttpResponse.json(mockSession)
      }),
    )

    renderWithClient(<UserMenu />)

    expect(await screen.findByTestId('user-menu-skeleton')).toBeInTheDocument()
    expect(screen.getByLabelText('Loading user menu')).toHaveAttribute(
      'aria-busy',
      'true',
    )

    await waitFor(() => {
      expect(screen.queryByTestId('user-menu-skeleton')).not.toBeInTheDocument()
    })
  })

  it("displays the user's username once the session resolves", async () => {
    renderWithClient(<UserMenu />)

    expect(
      await screen.findByText(mockSession.data.user.username),
    ).toBeInTheDocument()
    // Default mockSession has no email → guest aria-label nudges toward claiming.
    expect(screen.getByTestId('user-menu')).toHaveAttribute(
      'aria-label',
      `Guest account ${mockSession.data.user.username} — open menu to claim`,
    )
  })

  it('renders avatar initials derived from the username', async () => {
    const typed: SessionResponse = {
      data: { user: { username: 'maria.rossi', permissions: [] } },
    }
    server.use(
      http.get('*/v1/session', () => HttpResponse.json(typed)),
    )

    renderWithClient(<UserMenu />)

    expect(await screen.findByText('maria.rossi')).toBeInTheDocument()
    expect(screen.getByText('MR')).toBeInTheDocument()
  })

  it('truncates very long usernames via class and exposes full name as a tooltip', async () => {
    const longName = 'a-really-extraordinarily-long-username-that-should-truncate'
    const typed: SessionResponse = {
      data: { user: { username: longName, permissions: [] } },
    }
    server.use(
      http.get('*/v1/session', () => HttpResponse.json(typed)),
    )

    renderWithClient(<UserMenu />)

    const nameEl = await screen.findByText(longName)
    expect(nameEl).toHaveClass('app-shell__user-name--truncate')
    expect(nameEl).toHaveAttribute('title', longName)
  })

  it('opens a menu with a Settings link pointing at /settings', async () => {
    renderWithClient(<UserMenu />)

    const trigger = await screen.findByTestId('user-menu')
    await userEvent.click(trigger)

    const settings = await screen.findByRole('menuitem', { name: /^settings$/i })
    expect(settings).toHaveAttribute('href', '/settings')
  })

  it('shows the pulsing guest dot and Claim account item when the user has no email', async () => {
    renderWithClient(<UserMenu />)

    expect(await screen.findByTestId('user-menu-guest-dot')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('user-menu'))

    const claim = await screen.findByTestId('user-menu-claim-account')
    expect(claim).toHaveAttribute('href', '/settings#sec-email')
    expect(claim).toHaveTextContent('Claim account')
    expect(claim).toHaveTextContent('Save your matches and rating.')
  })

  it('hides the guest nudge once a claim is mid-flight (pending_email set)', async () => {
    const pending: SessionResponse = {
      data: {
        user: {
          username: 'rita.kovac',
          permissions: [],
          email: null,
          confirmed_at: null,
          pending_email: 'rita@kovac.club',
        },
      },
    }
    server.use(http.get('*/v1/session', () => HttpResponse.json(pending)))

    renderWithClient(<UserMenu />)

    await screen.findByText('rita.kovac')
    expect(screen.queryByTestId('user-menu-guest-dot')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('user-menu'))
    expect(
      screen.queryByTestId('user-menu-claim-account'),
    ).not.toBeInTheDocument()
  })

  it('hides the guest dot and Claim account item once the user has an email', async () => {
    const verified: SessionResponse = {
      data: {
        user: {
          username: 'rita.kovac',
          permissions: [],
          email: 'rita@kovac.club',
          confirmed_at: '2026-05-01T00:00:00Z',
        },
      },
    }
    server.use(http.get('*/v1/session', () => HttpResponse.json(verified)))

    renderWithClient(<UserMenu />)

    await screen.findByText('rita.kovac')
    expect(screen.queryByTestId('user-menu-guest-dot')).not.toBeInTheDocument()
    expect(screen.getByTestId('user-menu')).toHaveAttribute(
      'aria-label',
      'Signed in as rita.kovac',
    )

    await userEvent.click(screen.getByTestId('user-menu'))

    await screen.findByRole('menuitem', { name: /^settings$/i })
    expect(
      screen.queryByTestId('user-menu-claim-account'),
    ).not.toBeInTheDocument()
  })

  it('clicking Log out calls DELETE /v1/session and redirects to /dashboard', async () => {
    let deleteCalls = 0
    server.use(
      http.delete('*/v1/session', () => {
        deleteCalls += 1
        return new HttpResponse(null, { status: 204 })
      }),
    )

    renderWithClient(<UserMenu />)

    await screen.findByText(mockSession.data.user.username)
    await userEvent.click(screen.getByTestId('user-menu'))

    await userEvent.click(await screen.findByTestId('user-menu-logout'))

    await waitFor(() => {
      expect(deleteCalls).toBe(1)
    })
    expect(await screen.findByText('Dashboard page')).toBeInTheDocument()
  })
})
