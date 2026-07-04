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
import { describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { server } from '@/mocks/server'
import { mockSession } from '@/mocks/handlers'
import { Route as ConfirmEmailRoute } from './confirm-email'

vi.mock('sonner', async () => {
  const actual = await vi.importActual<typeof import('sonner')>('sonner')
  return {
    ...actual,
    toast: { ...actual.toast, success: vi.fn() },
  }
})

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

  it('treats a duplicated ?token=a&token=b as a single (invalid) token, not a missing one', async () => {
    // A repeated query param parses into an array. We take the first value, so
    // the page confirms with it and surfaces the generic invalid-link error
    // rather than the misleading "This link is missing its token." copy (#439).
    server.use(
      http.post('*/v1/me/email/confirm', () =>
        HttpResponse.json(
          { detail: 'That confirmation link is invalid or expired.' },
          { status: 400 },
        ),
      ),
    )
    renderAt('/confirm-email?token=first&token=second')

    await screen.findByText(/invalid or expired/i)
    expect(
      screen.queryByText(/this link is missing its token/i),
    ).not.toBeInTheDocument()
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

describe('/confirm-email merged-matches toast (#241)', () => {
  it('uses singular copy when exactly one match is merged', async () => {
    // Default `/v1/merge/preview` is a no-merge, so confirm-email auto-confirms;
    // the confirm response carries the merge summary that drives the toast.
    server.use(
      http.post('*/v1/me/email/confirm', () =>
        HttpResponse.json({
          ...mockSession,
          merged: { matches_moved: 1 },
        }),
      ),
    )
    renderAt('/confirm-email?token=good-token-with-one-merge')

    // confirm-email branches on `moved === 1` for the singular copy, the same
    // as login.verifying — lock the singular path in here too so a refactor
    // can't regress it to "We brought your 1 matches with you." (#241).
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        'We brought your 1 match with you.',
      )
    })
  })

  it('fires the toast exactly once for a single settled confirm (#233)', async () => {
    // #233: the toast effect previously had no once-guard ref, so a second
    // invocation of the same settled mutation (e.g. React StrictMode's
    // mount-time double-invoke) fired it twice. This locks in that a single
    // successful confirm produces exactly one toast call with this message —
    // the `toastFired` ref in confirm-email.tsx is what keeps it that way.
    server.use(
      http.post('*/v1/me/email/confirm', () =>
        HttpResponse.json({
          ...mockSession,
          merged: { matches_moved: 4 },
        }),
      ),
    )
    renderAt('/confirm-email?token=good-token-with-four-merges')

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        'We brought your 4 matches with you.',
      )
    })
    expect(
      vi.mocked(toast.success).mock.calls.filter(
        ([message]) => message === 'We brought your 4 matches with you.',
      ),
    ).toHaveLength(1)
  })
})
