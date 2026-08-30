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
    // The "Back to settings" route is present but demoted to a secondary
    // action, and nothing resend-shaped leads.
    expect(
      screen.getByRole('link', { name: /back to settings/i }),
    ).toBeInTheDocument()
    expect(screen.queryByText(/send a fresh/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/resend/i)).not.toBeInTheDocument()
    // States its instruction ONCE. The screen used to carry a footer line
    // ("Look for the most recent confirmation email") that repeated the
    // subtitle's own "Open the most recent email we sent you" — the exact
    // duplication this ticket set out to remove (#1616).
    expect(screen.getAllByText(/most recent/i)).toHaveLength(1)
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

  it.each([
    [
      'replaced',
      { code: 'replaced', message: 'A newer link was requested.' },
      /a newer link was sent/i,
    ],
    ['expired', 'That confirmation link is invalid or expired.', /this link can't be used/i],
  ])(
    'states the %s screen\'s instruction exactly once',
    async (_state, detail, heading) => {
      // Every failure state, not just one. The `replaced` screen shipped a
      // footer line that repeated its own subtitle, and a fixture that only
      // exercised `expired` stayed green through it (#1616).
      server.use(
        http.post('*/v1/me/email/confirm', () =>
          HttpResponse.json({ detail }, { status: 400 }),
        ),
      )
      renderAt('/confirm-email?token=dead-token')

      await screen.findByRole('heading', { name: heading })
      // The one instruction each screen gives, given once. `queryAllByText`,
      // not `getAllByText`: the latter throws on zero matches, so a screen
      // that dropped its instruction entirely would red on the wrong reason.
      expect(
        screen.queryAllByText(/most recent/i).length,
      ).toBeLessThanOrEqual(1)
      expect(
        screen.queryAllByText(/send a fresh one from settings/i).length,
      ).toBeLessThanOrEqual(1)
      // And never in sign-in wording.
      expect(screen.queryByText(/15 minutes/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/straight in/i)).not.toBeInTheDocument()
      expect(screen.queryByText(/sign-in link/i)).not.toBeInTheDocument()
    },
  )

  it('reports a missing token as an incomplete link, in confirmation wording', async () => {
    renderAt('/confirm-email')

    await screen.findByRole('heading', { name: /this link is incomplete/i })
    expect(screen.getByTestId('link-check-page')).toHaveAttribute(
      'data-state',
      'missing',
    )
    expect(screen.getByText(/confirmation link is missing its token/i)).toBeInTheDocument()
  })

  it("doesn't claim the newer link targets the same address", async () => {
    // The user may have changed the pending address after the first request —
    // the newer link then lives in a different inbox, so "requested for this
    // address" would send them looking in the wrong one (#1616 review).
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
    expect(
      screen.getByText(/it may be for a different address/i),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/requested for this address/i),
    ).not.toBeInTheDocument()
  })
})

describe('/confirm-email transient failures (#1616)', () => {
  it('sends a 5xx to the retryable error screen, not the expired screen', async () => {
    // A server-side failure says nothing about the token — telling the user
    // the link can't be used and to send a fresh one would replace a link
    // that is probably still live.
    server.use(
      http.post('*/v1/me/email/confirm', () =>
        HttpResponse.json({ detail: 'Internal server error' }, { status: 500 }),
      ),
    )
    renderAt('/confirm-email?token=maybe-good-token')

    await screen.findByRole('heading', { name: /we couldn't check this link/i })
    expect(screen.getByTestId('link-check-page')).toHaveAttribute(
      'data-state',
      'error',
    )
    expect(
      screen.queryByText(/this link can't be used/i),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/send a fresh one/i)).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /try again/i }),
    ).toBeInTheDocument()
  })

  it('sends a transport failure to the retryable error screen and retries the same token', async () => {
    // `HttpResponse.error()` aborts at the transport layer — the mutation
    // error isn't even an ApiError. The retry must re-fire the confirm with
    // the token the page was opened with, even though the URL scrubbing has
    // since removed it (#521).
    let calls = 0
    server.use(
      http.post('*/v1/me/email/confirm', () => {
        calls += 1
        return calls === 1 ? HttpResponse.error() : HttpResponse.json(mockSession)
      }),
    )
    renderAt('/confirm-email?token=flaky-token')

    await screen.findByRole('heading', { name: /we couldn't check this link/i })
    expect(screen.getByTestId('link-check-page')).toHaveAttribute(
      'data-state',
      'error',
    )
    expect(calls).toBe(1)

    screen.getByRole('button', { name: /try again/i }).click()

    await screen.findByText(/you’re in\./i)
    expect(calls).toBe(2)
  })

  it('replays skip_merge when a declined merge is retried after a transport failure', async () => {
    // "Not now" tells the server to sign the owner in without folding the
    // guest. If that request dies on a transport error, the retry must carry
    // the same skip_merge: true — replaying only the token would default it
    // back to false and merge the guest's matches the user explicitly
    // declined (#1616).
    const bodies: Array<{ token: string; skip_merge?: boolean }> = []
    server.use(
      http.post('*/v1/merge/preview', () =>
        HttpResponse.json({
          is_merge: true,
          owner_username: 'rita',
          guest_username: null,
          guest_matches_count: 2,
          adopts_guest_username: false,
        }),
      ),
      http.post('*/v1/me/email/confirm', async ({ request }) => {
        bodies.push(
          (await request.json()) as { token: string; skip_merge?: boolean },
        )
        return bodies.length === 1
          ? HttpResponse.error()
          : HttpResponse.json(mockSession)
      }),
    )
    renderAt('/confirm-email?token=declined-merge-token')

    await screen.findByRole('heading', { name: /bring your matches over/i })
    screen
      .getByRole('button', { name: /not now — just sign me in/i })
      .click()

    await screen.findByRole('heading', { name: /we couldn't check this link/i })

    screen.getByRole('button', { name: /try again/i }).click()

    await screen.findByText(/you’re in\./i)
    expect(bodies).toEqual([
      { token: 'declined-merge-token', skip_merge: true },
      { token: 'declined-merge-token', skip_merge: true },
    ])
  })

  it('keeps the confirming screen up while a retry is in flight', async () => {
    // After the first transient failure the URL scrub has cleared the token.
    // While the retry runs, the page must show the confirming screen — not
    // "This link is incomplete", which would hide the retry control and
    // offer a misleading route back to Settings mid-attempt (#1616).
    let calls = 0
    server.use(
      http.post('*/v1/me/email/confirm', () => {
        calls += 1
        if (calls === 1) return HttpResponse.error()
        return new Promise(() => {}) // hang: the retry stays pending
      }),
    )
    renderAt('/confirm-email?token=slow-retry-token')

    await screen.findByRole('heading', { name: /we couldn't check this link/i })
    expect(screen.getByTestId('link-check-page')).toHaveAttribute(
      'data-state',
      'error',
    )

    screen.getByRole('button', { name: /try again/i }).click()

    await waitFor(() => {
      expect(screen.getByTestId('link-check-page')).toHaveAttribute(
        'data-state',
        'checking',
      )
    })
    expect(
      screen.queryByText(/this link is incomplete/i),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /try again/i }),
    ).not.toBeInTheDocument()
  })

  it('keeps a non-coded 4xx on the expired screen', async () => {
    // A real rejection — the server saw the token and said no — is the only
    // thing the expired screen may claim.
    server.use(
      http.post('*/v1/me/email/confirm', () =>
        HttpResponse.json(
          { detail: 'That confirmation link is invalid or expired.' },
          { status: 400 },
        ),
      ),
    )
    renderAt('/confirm-email?token=dead-token')

    await screen.findByText(/this link can't be used/i)
    expect(screen.getByTestId('link-check-page')).toHaveAttribute(
      'data-state',
      'expired',
    )
    expect(
      screen.queryByRole('button', { name: /try again/i }),
    ).not.toBeInTheDocument()
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
