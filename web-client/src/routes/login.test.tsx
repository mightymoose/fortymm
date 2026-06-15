import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { toast } from 'sonner'
import { describe, expect, it, vi } from 'vitest'
import { server } from '@/mocks/server'
import { mockSession } from '@/mocks/handlers'
import { Route as LoginIndexRoute } from './login.index'
import { Route as LoginSentRoute } from './login.sent'
import { Route as LoginVerifyingRoute } from './login.verifying'
import { Route as LoginWelcomeRoute } from './login.welcome'

interface TestRouterContext {
  queryClient: QueryClient
}

// Replace the real Turnstile widget with a fake that hands a token to the
// form on mount — the production component loads a Cloudflare script that
// jsdom can't execute.
vi.mock('@/components/turnstile', () => ({
  Turnstile: ({ onToken }: { onToken: (token: string) => void }) => {
    onToken('fake-captcha-token')
    return <div data-testid="fake-turnstile" />
  },
}))

vi.mock('sonner', async () => {
  const actual = await vi.importActual<typeof import('sonner')>('sonner')
  return {
    ...actual,
    toast: { ...actual.toast, success: vi.fn() },
  }
})

function renderAt(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const rootRoute = createRootRouteWithContext<TestRouterContext>()()
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: LoginIndexRoute.options.component!,
    validateSearch: LoginIndexRoute.options.validateSearch,
  })
  const sentRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login/sent',
    component: LoginSentRoute.options.component!,
    validateSearch: LoginSentRoute.options.validateSearch,
  })
  const verifyingRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login/verifying',
    component: LoginVerifyingRoute.options.component!,
    validateSearch: LoginVerifyingRoute.options.validateSearch,
  })
  const welcomeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login/welcome',
    component: LoginWelcomeRoute.options.component!,
  })
  const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/dashboard',
    component: () => <div>Dashboard stub</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      sentRoute,
      verifyingRoute,
      welcomeRoute,
      dashboardRoute,
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

describe('/login flow', () => {
  it('submits the email and navigates to /login/sent on success', async () => {
    const user = userEvent.setup()
    const { router } = renderAt('/login')

    const input = await screen.findByLabelText('Email address')
    await user.type(input, 'rita@example.com')
    await user.click(screen.getByRole('button', { name: /send the link/i }))

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/login/sent')
    })
    expect(router.state.location.search).toMatchObject({
      email: 'rita@example.com',
    })
  })

  // Regression test for #436: the mutation's isPending only disables the
  // button on a batched re-render, so a synchronous click burst used to
  // dispatch one POST (and one sign-in email) per click.
  it('fires exactly one POST /login/request for a rapid multi-click', async () => {
    let requests = 0
    server.use(
      http.post('*/v1/login/request', async ({ request }) => {
        requests += 1
        const body = (await request.json()) as { email: string }
        // Stay in flight long enough for the burst to land while pending.
        await new Promise((resolve) => setTimeout(resolve, 25))
        return HttpResponse.json({ email: body.email }, { status: 202 })
      }),
    )
    const user = userEvent.setup()
    const { router } = renderAt('/login')

    const input = await screen.findByLabelText('Email address')
    await user.type(input, 'rita@example.com')

    // fireEvent (not userEvent) so all three clicks land in one synchronous
    // burst, before React re-renders with the disabled submitting button.
    const button = screen.getByRole('button', { name: /send the link/i })
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(button)

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/login/sent')
    })
    expect(requests).toBe(1)
  })

  it('keeps the user on /login and surfaces an inline error for bad emails', async () => {
    const user = userEvent.setup()
    const { router } = renderAt('/login')

    const input = await screen.findByLabelText('Email address')
    await user.type(input, 'definitely-not-an-email')
    await user.click(screen.getByRole('button', { name: /send the link/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /that doesn.t look like a valid email/i,
    )
    expect(router.state.location.pathname).toBe('/login')
  })

  it('routes back to /login when /v1/login/request fails with a 5xx', async () => {
    server.use(
      http.post('*/v1/login/request', () =>
        HttpResponse.json({ detail: 'Email down.' }, { status: 503 }),
      ),
    )
    const user = userEvent.setup()
    const { router } = renderAt('/login')

    const input = await screen.findByLabelText('Email address')
    await user.type(input, 'rita@example.com')
    await user.click(screen.getByRole('button', { name: /send the link/i }))

    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({
        error: 'send-failed',
      })
    })
    expect(
      await screen.findByRole('heading', { name: /couldn.t send/i }),
    ).toBeInTheDocument()
  })

  it('shows friendly guidance instead of the bare "Too Many Requests" on a 429', async () => {
    server.use(
      http.post('*/v1/login/request', () =>
        HttpResponse.json({ detail: 'Too Many Requests' }, { status: 429 }),
      ),
    )
    const user = userEvent.setup()
    const { router } = renderAt('/login')

    const input = await screen.findByLabelText('Email address')
    await user.type(input, 'rita@example.com')
    await user.click(screen.getByRole('button', { name: /send the link/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /too many sign-in attempts.*wait a minute/i,
    )
    expect(screen.queryByText(/too many requests/i)).not.toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/login')
  })
})

describe('/login/verifying flow', () => {
  it('consumes the token and routes to /login/welcome on success', async () => {
    const { router } = renderAt('/login/verifying?token=good-token')

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/login/welcome')
    })
    expect(
      await screen.findByRole('heading', { name: /welcome back/i }),
    ).toBeInTheDocument()
    // The session query data should now reflect a confirmed account.
    expect(mockSession.data.user.email).toBeTruthy()
  })

  it('routes to ?error=expired when the API rejects the token', async () => {
    const { router } = renderAt('/login/verifying?token=expired')

    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ error: 'expired' })
    })
    expect(
      await screen.findByRole('heading', { name: /this link can't be used/i }),
    ).toBeInTheDocument()
  })

  it('routes to ?error=net when the API is unreachable', async () => {
    server.use(
      http.post('*/v1/login/consume', () =>
        HttpResponse.json({ detail: 'down' }, { status: 503 }),
      ),
    )
    const { router } = renderAt('/login/verifying?token=anything')

    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ error: 'net' })
    })
    expect(
      await screen.findByRole('heading', { name: /couldn.t reach/i }),
    ).toBeInTheDocument()
  })

  it('shows a distinct missing-link screen (not "expired") when no token is supplied', async () => {
    renderAt('/login/verifying')
    expect(
      await screen.findByRole('heading', { name: /this link is incomplete/i }),
    ).toBeInTheDocument()
    expect(screen.getByText(/missing its token/i)).toBeInTheDocument()
    // It must not reuse the expired/already-used wording.
    expect(
      screen.queryByRole('heading', { name: /this link can't be used/i }),
    ).not.toBeInTheDocument()
  })

  it('toasts the merged-matches count when consume reports a merge', async () => {
    server.use(
      http.post('*/v1/login/consume', () =>
        HttpResponse.json({
          ...mockSession,
          merged: { matches_moved: 3 },
        }),
      ),
    )
    renderAt('/login/verifying?token=good-token-with-merge')

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        'We brought your 3 matches with you.',
      )
    })
  })

  it('does not toast when the consume response carries no merge', async () => {
    vi.mocked(toast.success).mockClear()
    renderAt('/login/verifying?token=good-token-no-merge')

    await waitFor(() => {
      // wait for the consume mutation to settle
      expect(screen.queryByRole('heading', { name: /welcome back/i })).toBeInTheDocument()
    })
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('shows the merge gate and consumes with the chosen skip_merge', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('*/v1/merge/preview', () =>
        HttpResponse.json({
          is_merge: true,
          owner_username: 'rita',
          guest_username: 'drifting-grouse',
          guest_matches_count: 2,
        }),
      ),
    )
    const consumed: Array<{ skip_merge?: boolean }> = []
    server.use(
      http.post('*/v1/login/consume', async ({ request }) => {
        consumed.push(
          (await request.json()) as { skip_merge?: boolean },
        )
        return HttpResponse.json(mockSession)
      }),
    )

    renderAt('/login/verifying?token=merge-token')

    // Gate appears instead of auto-finalizing.
    await screen.findByRole('heading', { name: /bring your matches over/i })
    expect(screen.getByText(/2 matches/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /bring them over/i }))

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /welcome back/i })).toBeInTheDocument(),
    )
    expect(consumed).toEqual([{ token: 'merge-token', skip_merge: false }])
  })

  it('signs in without merging when "not now" is chosen', async () => {
    const user = userEvent.setup()
    server.use(
      http.post('*/v1/merge/preview', () =>
        HttpResponse.json({
          is_merge: true,
          owner_username: 'rita',
          guest_username: 'drifting-grouse',
          guest_matches_count: 1,
        }),
      ),
    )
    const consumed: Array<{ skip_merge?: boolean }> = []
    server.use(
      http.post('*/v1/login/consume', async ({ request }) => {
        consumed.push((await request.json()) as { skip_merge?: boolean })
        return HttpResponse.json(mockSession)
      }),
    )

    renderAt('/login/verifying?token=merge-token')

    await screen.findByRole('heading', { name: /bring your matches over/i })
    await user.click(screen.getByRole('button', { name: /not now/i }))

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /welcome back/i })).toBeInTheDocument(),
    )
    expect(consumed).toEqual([{ token: 'merge-token', skip_merge: true }])
  })
})
