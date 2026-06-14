import { render, screen, waitFor } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from '@/mocks/server'
import { mockSession } from '@/mocks/handlers'
import { Route as ConfirmEmailRoute } from './confirm-email'

interface TestRouterContext {
  queryClient: QueryClient
}

function renderAt(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const rootRoute = createRootRouteWithContext<TestRouterContext>()()
  const confirmRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/confirm-email',
    component: ConfirmEmailRoute.options.component!,
    validateSearch: ConfirmEmailRoute.options.validateSearch,
  })
  // Stubs so the success/error footer <Link>s resolve.
  const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/dashboard',
    component: () => <div>Dashboard stub</div>,
  })
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: () => <div>Settings stub</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      confirmRoute,
      dashboardRoute,
      settingsRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    context: { queryClient },
  })
  return {
    router,
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  }
}

describe('/confirm-email token scrubbing (#521)', () => {
  it('scrubs the token from the URL after a successful confirm', async () => {
    server.use(
      http.post('*/v1/me/email/confirm', () => HttpResponse.json(mockSession)),
    )
    const { router } = renderAt('/confirm-email?token=good-token')

    // Lands on the success screen…
    await screen.findByText(/you’re in\./i)
    // …and the single-use token is gone from the address bar.
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ token: '' })
    })
  })

  it('scrubs the token from the URL after a failed confirm', async () => {
    server.use(
      http.post('*/v1/me/email/confirm', () =>
        HttpResponse.json(
          { detail: 'That confirmation link is invalid or expired.' },
          { status: 400 },
        ),
      ),
    )
    const { router } = renderAt('/confirm-email?token=bad-token')

    // The error screen still renders (mutation state, not the token, drives it)…
    await screen.findByText(/invalid or expired/i)
    // …with the token scrubbed.
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ token: '' })
    })
  })
})
