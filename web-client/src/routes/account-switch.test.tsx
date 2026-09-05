import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { server } from '@/mocks/server'
import { mockSession } from '@/mocks/handlers'
import { sessionQueryOptions, useSession } from '@/api/session'
import { Route as ConfirmRoute } from './confirm-email'
import { Route as VerifyRoute } from './login.verifying'

it.each([
  ['/confirm-email', '/v1/me/email/confirm', ConfirmRoute],
  ['/login/verifying', '/v1/login/consume', VerifyRoute],
] as const)(
  'asks before switching accounts through %s and supports canceling',
  async (path, endpoint, route) => {
    const user = userEvent.setup()
    const requests: unknown[] = []
    let changed = false
    server.use(
      http.post('*/v1/merge/preview', () =>
        HttpResponse.json({
          is_merge: false,
          account_switch: {
            from_user_id: 'alice-id',
            from_username: 'alice',
            to_username: 'bob',
          },
        }),
      ),
      http.post(`*${endpoint}`, async ({ request }) => {
        requests.push(await request.json())
        if (!changed) {
          changed = true
          return HttpResponse.json(
            {
              detail: {
                code: 'account_switch_required',
                account_switch: {
                  from_user_id: 'charlie-id',
                  from_username: 'charlie',
                  to_username: 'bob',
                },
              },
            },
            { status: 409 },
          )
        }
        return HttpResponse.json({
          ...mockSession,
          data: { user: { ...mockSession.data.user, username: 'bob' } },
        })
      }),
    )
    const root = createRootRoute()
    const link = createRoute({
      getParentRoute: () => root,
      path,
      component: route.options.component!,
      validateSearch: route.options.validateSearch,
    })
    const dashboard = createRoute({
      getParentRoute: () => root,
      path: '/dashboard',
      component: () => <h1>Dashboard</h1>,
    })
    const welcome = createRoute({
      getParentRoute: () => root,
      path: '/login/welcome',
      component: () => <h1>Signed in</h1>,
    })
    const router = createRouter({
      routeTree: root.addChildren([link, dashboard, welcome]),
      history: createMemoryHistory({
        initialEntries: [`${path}?token=bobs-link`],
      }),
    })
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )
    expect(
      await screen.findByRole('heading', { name: 'Continue as bob?' }),
    ).toBeVisible()
    expect(requests).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(
      await screen.findByRole('heading', { name: 'Dashboard' }),
    ).toBeVisible()
    expect(requests).toEqual([])
    await router.navigate({ to: path, search: { token: 'bobs-link' } })
    await user.click(
      await screen.findByRole('button', { name: 'Continue as bob' }),
    )
    await waitFor(() =>
      expect(requests).toEqual([
        {
          token: 'bobs-link',
          skip_merge: false,
          switch_from_user_id: 'alice-id',
        },
      ]),
    )
    expect(await screen.findByText(/You're signed in as charlie/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Continue as bob' }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]).toEqual({
      token: 'bobs-link',
      skip_merge: false,
      switch_from_user_id: 'charlie-id',
    })
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'Continue as bob?' }),
      ).not.toBeInTheDocument(),
    )
  },
)

it('offers retry when rechecking a changed sign-in cannot reach the server', async () => {
  const user = userEvent.setup()
  let previews = 0
  let consumes = 0
  server.use(
    http.post('*/v1/merge/preview', () => {
      previews += 1
      return previews === 1
        ? HttpResponse.json({ is_merge: false, account_switch: {
            from_user_id: 'alice-id', from_username: 'alice', to_username: 'bob',
          } })
        : new HttpResponse(null, { status: 503 })
    }),
    http.post('*/v1/login/consume', () => {
      consumes += 1
      return consumes === 1
        ? HttpResponse.json({ detail: {
            code: 'account_switch_required', account_switch: null,
          } }, { status: 409 })
        : new HttpResponse(null, { status: 503 })
    }),
  )
  const root = createRootRoute()
  const verifying = createRoute({
    getParentRoute: () => root,
    path: '/login/verifying',
    component: VerifyRoute.options.component!,
    validateSearch: VerifyRoute.options.validateSearch,
  })
  const router = createRouter({
    routeTree: root.addChildren([verifying]),
    history: createMemoryHistory({ initialEntries: ['/login/verifying?token=bobs-link'] }),
  })
  render(<QueryClientProvider client={new QueryClient()}>
    <RouterProvider router={router} />
  </QueryClientProvider>)
  await user.click(await screen.findByRole('button', { name: 'Continue as bob' }))
  await user.click(await screen.findByRole('button', { name: 'Review link' }))
  expect(await screen.findByRole('button', { name: 'Retry verification' })).toBeVisible()
})

it('keeps Not now when a confirmation re-preview fails after the source changes', async () => {
  const user = userEvent.setup()
  let previews = 0
  const confirmations: unknown[] = []
  server.use(
    http.post('*/v1/merge/preview', () => {
      previews += 1
      return previews === 1
        ? HttpResponse.json({ is_merge: true, guest_matches_count: 1,
            owner_username: 'bob', guest_username: 'guest',
            account_switch: { from_user_id: 'alice-id', from_username: 'alice', to_username: 'bob' },
          })
        : new HttpResponse(null, { status: 503 })
    }),
    http.post('*/v1/me/email/confirm', async ({ request }) => {
      confirmations.push(await request.json())
      return confirmations.length === 1
        ? HttpResponse.json({ detail: { code: 'account_switch_required', account_switch: null } }, { status: 409 })
        : HttpResponse.json(mockSession)
    }),
  )
  const root = createRootRoute()
  const confirming = createRoute({ getParentRoute: () => root,
    path: '/confirm-email', component: ConfirmRoute.options.component!,
    validateSearch: ConfirmRoute.options.validateSearch,
  })
  const router = createRouter({ routeTree: root.addChildren([confirming]),
    history: createMemoryHistory({ initialEntries: ['/confirm-email?token=bobs-link'] }),
  })
  render(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>)
  await user.click(await screen.findByRole('button', { name: 'Continue as bob' }))
  await user.click(await screen.findByRole('button', { name: /not now/i }))
  await user.click(await screen.findByRole('button', { name: 'Review link' }))
  await waitFor(() => expect(confirmations).toHaveLength(2))
  expect(confirmations[1]).toEqual({ token: 'bobs-link', skip_merge: true })
})

it.each([
  ['/confirm-email', '/v1/me/email/confirm', ConfirmRoute],
  ['/login/verifying', '/v1/login/consume', VerifyRoute],
] as const)('reloads the current identity when canceling a changed sign-in at %s', async (path, endpoint, route) => {
  const user = userEvent.setup()
  const qc = new QueryClient()
  qc.setQueryData(sessionQueryOptions().queryKey, {
    ...mockSession, data: { user: { ...mockSession.data.user, username: 'alice' } },
  })
  server.use(
    http.post('*/v1/merge/preview', () => HttpResponse.json({
      is_merge: false, account_switch: { from_user_id: 'alice-id', from_username: 'alice', to_username: 'bob' },
    })),
    http.post(`*${endpoint}`, () => HttpResponse.json({
      detail: { code: 'account_switch_required', account_switch: null },
    }, { status: 409 })),
    http.get('*/v1/session', () => HttpResponse.json({
      ...mockSession, data: { user: { ...mockSession.data.user, username: 'bob' } },
    })),
  )
  function DashboardIdentity() {
    const session = useSession()
    return <h1>Signed in as {session.data?.data.user.username}</h1>
  }
  const root = createRootRoute()
  const link = createRoute({ getParentRoute: () => root, path,
    component: route.options.component!, validateSearch: route.options.validateSearch,
  })
  const dashboard = createRoute({ getParentRoute: () => root, path: '/dashboard', component: DashboardIdentity })
  const router = createRouter({ routeTree: root.addChildren([link, dashboard]),
    history: createMemoryHistory({ initialEntries: [`${path}?token=bobs-link`] }),
  })
  render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>)
  await user.click(await screen.findByRole('button', { name: 'Continue as bob' }))
  expect(await screen.findByRole('button', { name: 'Review link' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(await screen.findByRole('heading', { name: 'Signed in as bob' })).toBeVisible()
})
