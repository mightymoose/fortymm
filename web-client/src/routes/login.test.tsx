import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HttpResponse, delay, http } from 'msw'
import { toast } from 'sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/mocks/server'
import { api } from '@/api/client'
import { Route as AppRoute } from './_app/route'
import { mockSession } from '@/mocks/handlers'
import { Route as LoginIndexRoute } from './login.index'
import { Route as LoginSentRoute } from './login.sent'
import { Route as LoginVerifyingRoute } from './login.verifying'
import { Route as LoginWelcomeRoute } from './login.welcome'

interface TestRouterContext {
  queryClient: QueryClient
}

// Shared control surface for the Turnstile stub below. `auto` hands a token
// on mount — the behaviour most tests rely on. `defer` holds the widget's
// callbacks so a test can release a token (or fire the error path) after
// asserting the pre-token UI, reproducing the cold-load window where no token
// exists yet (#1462).
const turnstileStub = vi.hoisted(() => ({
  mode: 'auto' as 'auto' | 'defer',
  // Assigned by the stubbed widget once it renders in `defer` mode.
  giveToken: null as null | ((token: string) => void),
  failWidget: null as null | (() => void),
}))

// Replace the real Turnstile widget with a fake that hands a token to the
// form on mount — the production component loads a Cloudflare script that
// jsdom can't execute.
vi.mock('@/components/turnstile', () => ({
  Turnstile: ({
    onToken,
    onError,
  }: {
    onToken: (token: string) => void
    onError?: () => void
  }) => {
    if (turnstileStub.mode === 'defer') {
      turnstileStub.giveToken = onToken
      turnstileStub.failWidget = () => onError?.()
      return <div data-testid="deferred-turnstile" />
    }
    onToken('fake-captcha-token')
    return <div data-testid="fake-turnstile" />
  },
}))

afterEach(() => {
  turnstileStub.mode = 'auto'
})

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
    beforeLoad: AppRoute.options.beforeLoad,
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

  // Regression pair for #1462: the Turnstile token needs a script fetch, a
  // widget render and a challenge solve, so for the first second or so of a
  // cold load there is no token. The submit button used to accept that click,
  // set "Complete the check above…" and have onToken clear the message again
  // a moment later — reading as a dead button. It must visibly refuse clicks
  // until the token exists instead.

  it('waits visibly for the captcha token, then submits exactly once it lands (#1462)', async () => {
    turnstileStub.mode = 'defer'
    let requests = 0
    server.use(
      http.post('*/v1/login/request', async ({ request }) => {
        requests += 1
        const body = (await request.json()) as { email: string }
        return HttpResponse.json({ email: body.email }, { status: 202 })
      }),
    )
    const user = userEvent.setup()
    const { router } = renderAt('/login')

    const input = await screen.findByLabelText('Email address')
    await user.type(input, 'rita@example.com')

    // Pre-token: disabled with an explained waiting label; neither a click
    // nor implicit Enter submission reaches the network.
    const waitingBtn = screen.getByRole('button', { name: /getting ready/i })
    expect(waitingBtn).toBeDisabled()
    fireEvent.click(waitingBtn)
    await user.type(input, '{enter}')
    expect(requests).toBe(0)
    expect(router.state.location.pathname).toBe('/login')

    // Token lands: enabled with its normal label, one click → one POST.
    act(() => turnstileStub.giveToken?.('late-captcha-token'))
    const sendBtn = screen.getByRole('button', { name: /^send the link$/i })
    expect(sendBtn).toBeEnabled()
    await user.click(sendBtn)

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/login/sent')
    })
    expect(requests).toBe(1)
  })

  it('swaps the waiting label for a visible alert and stays disabled when the captcha errors (#1462)', async () => {
    turnstileStub.mode = 'defer'
    const user = userEvent.setup()
    renderAt('/login')

    const input = await screen.findByLabelText('Email address')
    await user.type(input, 'rita@example.com')
    expect(screen.getByRole('button', { name: /getting ready/i })).toBeDisabled()

    // Widget-level error: no silent return to "Getting ready…", no enable.
    act(() => turnstileStub.failWidget?.())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /anti-bot check hit a snag/i,
    )
    expect(
      screen.queryByRole('button', { name: /getting ready/i }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^send the link$/i })).toBeDisabled()
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

describe('/login/sent flow', () => {
  it('"Resend" re-issues the link in place and resets the countdown (#519)', async () => {
    let requests = 0
    server.use(
      http.post('*/v1/login/request', async ({ request }) => {
        requests += 1
        const body = (await request.json()) as { email: string }
        return HttpResponse.json({ email: body.email }, { status: 202 })
      }),
    )
    const user = userEvent.setup()
    const { router } = renderAt('/login/sent?email=rita@example.com&sentAt=1000')

    // The hidden Turnstile hands over a token on mount, enabling Resend.
    const resendBtn = await screen.findByRole('button', { name: /^resend$/i })
    await waitFor(() => expect(resendBtn).toBeEnabled())
    await user.click(resendBtn)

    await waitFor(() => expect(requests).toBe(1))
    // Stays on the sent page (does NOT route back to /login like Start over).
    expect(router.state.location.pathname).toBe('/login/sent')
    // Fresh send time → the expiry countdown restarts.
    expect(router.state.location.search.sentAt).not.toBe(1000)
    expect(await screen.findByText(/new link sent/i)).toBeInTheDocument()
  })

  it('throttles Resend with a cooldown right after the link was sent, so a rapid burst stays put (#616)', async () => {
    let requests = 0
    server.use(
      http.post('*/v1/login/request', async ({ request }) => {
        requests += 1
        const body = (await request.json()) as { email: string }
        return HttpResponse.json({ email: body.email }, { status: 202 })
      }),
    )
    // A just-sent link (sentAt ≈ now) opens the cooldown window.
    const { router } = renderAt(
      `/login/sent?email=rita@example.com&sentAt=${Date.now()}`,
    )

    // The button shows the cooldown countdown and is disabled.
    const resendBtn = await screen.findByRole('button', {
      name: /resend in \d+s/i,
    })
    expect(resendBtn).toBeDisabled()

    // A synchronous click burst neither fires a request nor bounces to /login.
    fireEvent.click(resendBtn)
    fireEvent.click(resendBtn)
    fireEvent.click(resendBtn)

    expect(requests).toBe(0)
    expect(router.state.location.pathname).toBe('/login/sent')
  })

  it('keeps the user on the sent screen and shows guidance when a resend errors (#616)', async () => {
    server.use(
      http.post('*/v1/login/request', () =>
        HttpResponse.json({ detail: 'Too Many Requests' }, { status: 429 }),
      ),
    )
    const user = userEvent.setup()
    // Old sentAt → cooldown already elapsed, so Resend is enabled.
    const { router } = renderAt('/login/sent?email=rita@example.com&sentAt=1000')

    const resendBtn = await screen.findByRole('button', { name: /^resend$/i })
    await waitFor(() => expect(resendBtn).toBeEnabled())
    await user.click(resendBtn)

    expect(await screen.findByText(/lot of links/i)).toBeInTheDocument()
    // Did NOT bounce back to /login.
    expect(router.state.location.pathname).toBe('/login/sent')
  })

  // Regression test for #226: `?error=bounce` used to render a dead-end screen
  // full of fabricated delivery diagnostics (a made-up SMTP reason, mail server
  // and "did you mean" address). Nothing ever sets it, so a hand-typed URL was
  // the only way in. The key is dropped from the search schema now — the page
  // must fall through to the normal "check your inbox" screen, not blank out.
  it('falls through to the normal sent screen for a hand-typed ?error=bounce', async () => {
    const { router } = renderAt(
      '/login/sent?error=bounce&email=rita@example.com&sentAt=1000',
    )

    // The route's search schema has no `error` key, so nothing reads one: the
    // page renders its single, normal state instead of blanking or crashing.
    expect(
      await screen.findByRole('heading', { name: /link sent to rita@example.com/i }),
    ).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/login/sent')
    // None of the deleted bounce screen's fabricated fixtures reach the user.
    expect(screen.queryByText(/couldn.t deliver/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/tomas\.fischer@club37\.de/)).not.toBeInTheDocument()
    expect(screen.queryByText(/550 5\.1\.1/)).not.toBeInTheDocument()
  })

  it('"Start over" routes back to /login with the email prefilled', async () => {
    const user = userEvent.setup()
    const { router } = renderAt('/login/sent?email=rita@example.com&sentAt=1000')

    const [startOver] = await screen.findAllByRole('button', {
      name: /start over/i,
    })
    await user.click(startOver)

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
    expect(router.state.location.search).toMatchObject({
      email: 'rita@example.com',
    })
  })

  // #1466 defect 1: the From row is sourced from `GET /v1/login/sender` — a
  // fetch this screen must NEVER block or break on. These are route-level
  // (not component-level) checks: they render the real page through the
  // router, with the sender endpoint actually failing/hanging, rather than
  // asserting on `ScreenSent`/`EmailReceipt` in isolation.
  it('renders the real sent screen (heading, Resend, receipt) once the sender address resolves', async () => {
    server.use(
      http.get('*/v1/login/sender', () =>
        HttpResponse.json({ address: 'noreply@fortymm.com' }),
      ),
    )
    renderAt('/login/sent?email=rita@example.com&sentAt=1000')

    expect(
      await screen.findByRole('heading', { name: /link sent to rita@example.com/i }),
    ).toBeInTheDocument()
    expect(await screen.findByText('noreply@fortymm.com')).toBeInTheDocument()
  })

  it('still renders fully — no blank page, no error boundary — when the sender fetch fails', async () => {
    server.use(http.get('*/v1/login/sender', () => HttpResponse.error()))
    renderAt('/login/sent?email=rita@example.com&sentAt=1000')

    expect(
      await screen.findByRole('heading', { name: /link sent to rita@example.com/i }),
    ).toBeInTheDocument()
    expect(
      await screen.findByRole('button', { name: /^resend$/i }),
    ).toBeInTheDocument()
    // No From row rather than a broken/empty one.
    expect(screen.queryByText('From')).not.toBeInTheDocument()
  })

  it('still renders fully while the sender fetch never resolves', async () => {
    server.use(
      http.get('*/v1/login/sender', async () => {
        await delay('infinite')
      }),
    )
    renderAt('/login/sent?email=rita@example.com&sentAt=1000')

    expect(
      await screen.findByRole('heading', { name: /link sent to rita@example.com/i }),
    ).toBeInTheDocument()
    expect(screen.queryByText('From')).not.toBeInTheDocument()
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
    // The consumed session (written into the query cache) reflects a confirmed
    // account — the success receipt shows its email. Asserting on the rendered
    // output instead of the shared `mockSession` singleton keeps this test from
    // depending on a handler mutating module state (#229).
    expect(await screen.findByText('rita@example.com')).toBeInTheDocument()
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

  it('uses singular copy when exactly one match is merged', async () => {
    server.use(
      http.post('*/v1/login/consume', () =>
        HttpResponse.json({
          ...mockSession,
          merged: { matches_moved: 1 },
        }),
      ),
    )
    renderAt('/login/verifying?token=good-token-with-one-merge')

    // Lock in the singular branch so a future refactor can't regress this to
    // the ungrammatical "We brought your 1 matches with you." (#241).
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        'We brought your 1 match with you.',
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

  it('carries adopts_guest_username from the preview into the gate (#1292)', async () => {
    // Pins the prop wiring in login.verifying.tsx, not the gate's own copy —
    // merge-gate.test.tsx renders the component directly, so deleting the
    // `adoptsGuestUsername={...}` line there left every test green.
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

    renderAt('/login/verifying?token=first-sign-in-token')

    await screen.findByRole('heading', { name: /bring your matches over/i })
    expect(screen.getByText(/this also keeps your name/i)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /not now — sign me in as rita/i }),
    ).toBeInTheDocument()
  })
})


it('keeps the session-ended notice after reopening sign-in and offers an explicit new guest', async () => {
  server.use(http.get('*/v1/session', () => HttpResponse.json({
    detail: { code: 'session_ended', message: "You've been signed out. Sign in to continue." },
  }, { status: 401 })))
  await api.GET('/v1/session')
  const first = renderAt('/login')
  expect(await screen.findByRole('alert')).toHaveTextContent("You've been signed out")
  first.unmount()
  renderAt('/login')
  expect(await screen.findByRole('alert')).toHaveTextContent("You've been signed out")
  expect(screen.getByRole('button', { name: 'Continue as a new guest' })).toBeVisible()
})


it('redirects a direct dashboard visit after eviction without bootstrapping a guest', async () => {
  server.use(http.get('*/v1/session', () => HttpResponse.json({
    detail: { code: 'session_ended', message: "You've been signed out. Sign in to continue." },
  }, { status: 401 })))
  await api.GET('/v1/session')
  const { router } = renderAt('/dashboard')
  await waitFor(() => expect(router.state.location.pathname).toBe('/login'))
  expect(await screen.findByRole('alert')).toHaveTextContent("You've been signed out")
})
