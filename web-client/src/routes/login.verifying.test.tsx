import { render, screen } from '@testing-library/react'
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
import { Route as LoginVerifyingRoute } from './login.verifying'

interface TestRouterContext {
  queryClient: QueryClient
}

function renderAt(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const rootRoute = createRootRouteWithContext<TestRouterContext>()()
  const verifyingRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login/verifying',
    component: LoginVerifyingRoute.options.component!,
    validateSearch: LoginVerifyingRoute.options.validateSearch,
  })
  // Stubs so the footer/redirect targets resolve.
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <div>Login stub</div>,
  })
  const welcomeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login/welcome',
    component: () => <div>Welcome stub</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      verifyingRoute,
      loginRoute,
      welcomeRoute,
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

// The API caps the taxonomy at three codes (`invalid_or_expired`,
// `email_changed`, `replaced`) on a structured `{ detail: { code, message } }`
// 400 body — see api/app/sessions.py. These tests pin that the web client
// reads `code` and reaches a DISTINCT screen per code, rather than the old
// behaviour of collapsing every 4xx into `expired` (#1466 defect 3).
describe('/login/verifying error taxonomy (#1466 defect 3)', () => {
  it('FALSIFICATION: a `replaced` code must NOT route to the expired screen', async () => {
    // This is the exact regression the ticket describes: `consume_login_token`
    // now distinguishes `replaced` from `invalid_or_expired`, and the client
    // must not re-collapse them. If the old `err.status >= 400 && < 500 ->
    // 'expired'` mapping were still in place, this assertion would fail here
    // (heading would read "This link can't be used" instead of "A newer link
    // was sent") — see the PASS/FAIL note in the handoff for the manual
    // before/after run.
    server.use(
      http.post('*/v1/login/consume', () =>
        HttpResponse.json(
          {
            detail: {
              code: 'replaced',
              message: 'A newer sign-in link was requested. Use the most recent email.',
            },
          },
          { status: 400 },
        ),
      ),
    )
    renderAt('/login/verifying?token=replaced-token')

    await screen.findByRole('heading', { name: /newer link was sent/i })
    expect(
      screen.queryByRole('heading', { name: /this link can.t be used/i }),
    ).not.toBeInTheDocument()
  })

  it('routes `invalid_or_expired` to the expired screen (today\'s behaviour, unchanged)', async () => {
    server.use(
      http.post('*/v1/login/consume', () =>
        HttpResponse.json(
          {
            detail: {
              code: 'invalid_or_expired',
              message: 'That sign-in link is invalid or expired.',
            },
          },
          { status: 400 },
        ),
      ),
    )
    renderAt('/login/verifying?token=dead-token')

    await screen.findByRole('heading', { name: /this link can.t be used/i })
  })

  it('routes `email_changed` to its own screen, not expired', async () => {
    server.use(
      http.post('*/v1/login/consume', () =>
        HttpResponse.json(
          {
            detail: {
              code: 'email_changed',
              message: 'That sign-in link no longer matches your email.',
            },
          },
          { status: 400 },
        ),
      ),
    )
    renderAt('/login/verifying?token=stale-email-token')

    await screen.findByRole('heading', { name: /doesn.t match anymore/i })
    expect(
      screen.queryByRole('heading', { name: /this link can.t be used/i }),
    ).not.toBeInTheDocument()
  })

  it('falls back to the expired screen for an unparseable/plain-string 4xx body', async () => {
    // Pre-#1466 error shape (a bare string `detail`) — must still fall back
    // to the safe "expired" screen rather than crash or mis-render.
    server.use(
      http.post('*/v1/login/consume', () =>
        HttpResponse.json(
          { detail: 'Something else went wrong.' },
          { status: 400 },
        ),
      ),
    )
    renderAt('/login/verifying?token=weird-token')

    await screen.findByRole('heading', { name: /this link can.t be used/i })
  })

  it('the `replaced` screen offers a demoted "Send a new link instead", never the primary CTA', async () => {
    server.use(
      http.post('*/v1/login/consume', () =>
        HttpResponse.json(
          {
            detail: {
              code: 'replaced',
              message: 'A newer sign-in link was requested. Use the most recent email.',
            },
          },
          { status: 400 },
        ),
      ),
    )
    renderAt('/login/verifying?token=replaced-token')

    await screen.findByRole('button', { name: /send a new link instead/i })
    // The primary, full-width "Send a new link" CTA every other error state
    // uses must NOT be this screen's main action.
    expect(
      screen.queryByRole('button', { name: /^send a new link$/i }),
    ).not.toBeInTheDocument()
  })
})

describe('/login/verifying regressions the taxonomy change must not touch', () => {
  it('dedups a duplicated ?token=a&token=b to the first value (validateSearch)', () => {
    // Pure-function check of the boundary parse itself (root CLAUDE.md
    // "parse untrusted data at every boundary") — the consume mutation
    // clears `token` back to '' on ANY 4xx (including this one, since a
    // duplicated param is treated as a single likely-invalid token), so
    // asserting the post-navigation URL can't distinguish "used 'first'"
    // from "used 'second'". Asserting the parse itself can.
    const validateSearch = LoginVerifyingRoute.options.validateSearch as (
      search: Record<string, unknown>,
    ) => { token: string; error?: string }
    const result = validateSearch({ token: ['first', 'second'] })
    expect(result.token).toBe('first')
  })

  it('a duplicated token still reaches the generic invalid-link screen, not "missing"', async () => {
    server.use(
      http.post('*/v1/login/consume', () =>
        HttpResponse.json(
          {
            detail: {
              code: 'invalid_or_expired',
              message: 'That sign-in link is invalid or expired.',
            },
          },
          { status: 400 },
        ),
      ),
    )
    renderAt('/login/verifying?token=first&token=second')

    await screen.findByRole('heading', { name: /this link can.t be used/i })
    expect(
      screen.queryByRole('heading', { name: /this link is incomplete/i }),
    ).not.toBeInTheDocument()
  })

  it('a link with no token at all reports the incomplete-link state, client-side', async () => {
    renderAt('/login/verifying')

    await screen.findByRole('heading', { name: /this link is incomplete/i })
  })
})
