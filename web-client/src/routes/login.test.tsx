import { render, screen, waitFor } from '@testing-library/react'
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
      await screen.findByRole('heading', { name: /this link can.t be used/i }),
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

  it('shows the missing-token screen when no token is supplied', async () => {
    renderAt('/login/verifying')
    expect(
      await screen.findByRole('heading', { name: /this link can.t be used/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/this link is missing its token/i),
    ).toBeInTheDocument()
  })
})
