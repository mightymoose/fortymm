import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { server } from '@/mocks/server'
import { mockSession } from '@/mocks/handlers'
import { sessionQueryOptions } from '@/api/session'
import { AppError } from './app-error'

// Mirror the production wiring: a layout route whose loader bootstraps the
// session (like `_app`) with AppError as its `errorComponent`. When
// `GET /v1/session` fails the loader rejects and the route renders AppError (#292).
function renderApp() {
  const queryClient = new QueryClient({
    // The session query owns its retry predicate; zero the delay so the few
    // retries it does run resolve instantly instead of stalling the test.
    defaultOptions: { queries: { retryDelay: 0 } },
  })
  const rootRoute = createRootRoute()
  const layoutRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    loader: () => queryClient.ensureQueryData(sessionQueryOptions()),
    errorComponent: AppError,
    component: () => <div>dashboard-content</div>,
  })
  const routeTree = rootRoute.addChildren([layoutRoute])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('AppError (global session-bootstrap boundary)', () => {
  it('shows the branded error screen when the session bootstrap fails', async () => {
    server.use(
      http.get('*/v1/session', () => new HttpResponse(null, { status: 500 })),
    )

    renderApp()

    expect(
      await screen.findByText('Something went wrong.'),
    ).toBeInTheDocument()
    // The failing page content never renders — no silent forever-skeleton.
    expect(screen.queryByText('dashboard-content')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Try again' }),
    ).toBeInTheDocument()
  })

  it('renders nothing on a session_merged 401, deferring to the /login redirect', async () => {
    // The global session-ended middleware owns this case (clear + redirect);
    // AppError must not flash its generic "Something went wrong" screen (#672).
    server.use(
      http.get(
        '*/v1/session',
        () =>
          HttpResponse.json(
            { detail: { code: 'session_merged', message: 'Merged away.' } },
            { status: 401 },
          ),
      ),
    )

    const { container } = renderApp()

    // The boundary still catches the rejected loader (no dashboard content),
    // but renders null instead of the generic error screen.
    await waitFor(() =>
      expect(screen.queryByText('dashboard-content')).not.toBeInTheDocument(),
    )
    expect(screen.queryByText('Something went wrong.')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Try again' }),
    ).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })

  it('recovers to the page when retry succeeds', async () => {
    // Flip the flag (rather than counting attempts) so the test doesn't couple
    // to the session query's retry count: the bootstrap fails, then the retry
    // click — after we clear the flag — lets the refetch through.
    let failSession = true
    server.use(
      http.get('*/v1/session', () =>
        failSession
          ? new HttpResponse(null, { status: 500 })
          : HttpResponse.json(mockSession),
      ),
    )

    renderApp()
    await screen.findByText('Something went wrong.')

    failSession = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByText('dashboard-content')).toBeInTheDocument()
    expect(screen.queryByText('Something went wrong.')).not.toBeInTheDocument()
  })
})
