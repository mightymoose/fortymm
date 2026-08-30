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

    await screen.findByText(/this link can't be used/i)
    expect(screen.getByTestId('link-check-page')).toHaveAttribute(
      'data-state',
      'expired',
    )
    expect(
      screen.queryByText(/this link is incomplete/i),
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
    await screen.findByText(/this link can't be used/i)
    // …with the token scrubbed.
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ token: '' })
    })
  })
})

describe('/confirm-email failure copy (#1616)', () => {
  it('maps a coded replaced 4xx onto the replaced screen and demotes the action', async () => {
    // A link a newer resend replaced must say so — not collapse into the
    // generic expired screen — and must not offer, as its main action,
    // anything that would kill the newer link the copy points to.
    server.use(
      http.post('*/v1/me/email/confirm', () =>
        HttpResponse.json(
          {
            detail: {
              code: 'replaced',
              message:
                'A newer confirmation link was requested. Open the most recent email.',
            },
          },
          { status: 400 },
        ),
      ),
    )
    renderAt('/confirm-email?token=superseded-token')

    await screen.findByRole('heading', { name: /a newer link was sent/i })
    expect(screen.getByTestId('link-check-page')).toHaveAttribute(
      'data-state',
      'replaced',
    )
    // Guidance before anything resend-shaped; the "Back to settings" route is
    // present but demoted to a secondary action.
    expect(
      screen.getByText(/look for the most recent confirmation email/i),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /back to settings/i }),
    ).toBeInTheDocument()
    expect(screen.queryByText(/send a fresh/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/resend/i)).not.toBeInTheDocument()
  })

  it('renders every failure in confirmation wording and states the reason once', async () => {
    // No sign-in copy (15 minutes / "straight in"), and no duplicate of the
    // API's own sentence under a subtitle that already says it.
    server.use(
      http.post('*/v1/me/email/confirm', () =>
        HttpResponse.json(
          { detail: 'That confirmation link is invalid or expired.' },
          { status: 400 },
        ),
      ),
    )
    renderAt('/confirm-email?token=dead-token')

    await screen.findByRole('heading', { name: /this link can't be used/i })
    expect(screen.getByTestId('link-check-page')).toHaveAttribute(
      'data-state',
      'expired',
    )
    expect(screen.getByText(/confirmation links last 24 hours/i)).toBeInTheDocument()
    // Still offers the route to Resend.
    expect(
      screen.getByRole('link', { name: /back to settings/i }),
    ).toBeInTheDocument()
    // Sign-in copy and the duplicated detail line are gone.
    expect(screen.queryByText(/sign-in links last 15 minutes/i)).not.toBeInTheDocument()
    expect(
      screen.queryByText(/that confirmation link is invalid or expired/i),
    ).not.toBeInTheDocument()
  })

  it('reports a missing token as an incomplete link, in confirmation wording', async () => {
    renderAt('/confirm-email')

    await screen.findByRole('heading', { name: /this link is incomplete/i })
    expect(screen.getByTestId('link-check-page')).toHaveAttribute(
      'data-state',
      'missing',
    )
    expect(screen.getByText(/confirmation link is missing its token/i)).toBeInTheDocument()
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
    // #233: the toast used to live in a useEffect with no once-guard ref, so a
    // second invocation of the same settled mutation (e.g. React StrictMode's
    // mount-time double-invoke) fired it twice. This locks in that a single
    // successful confirm produces exactly one toast call with this message —
    // confirm-email.tsx now fires it from each confirm.mutate call's own
    // onSuccess, which React Query only ever invokes once per call.
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

  it('carries adopts_guest_username from the preview into the gate (#1292)', async () => {
    // Pins the prop wiring in confirm-email.tsx. merge-gate.test.tsx renders
    // the component directly, so deleting the `adoptsGuestUsername={...}` line
    // here left every test green.
    server.use(
      http.post('*/v1/merge/preview', () =>
        HttpResponse.json({
          is_merge: true,
          owner_username: 'rita',
          guest_username: 'drifting-grouse',
          guest_matches_count: 2,
          adopts_guest_username: true,
        }),
      ),
    )

    renderAt('/confirm-email?token=first-sign-in-token')

    await screen.findByRole('heading', { name: /bring your matches over/i })
    expect(screen.getByText(/this also keeps your name/i)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /not now — sign me in as rita/i }),
    ).toBeInTheDocument()
  })
})
