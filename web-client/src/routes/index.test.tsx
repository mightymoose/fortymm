import { render, screen } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it } from 'vitest'
import { APP_ENTERED_KEY } from '@/lib/landing-redirect'
import { Route as IndexRoute } from './index'

interface TestRouterContext {
  queryClient: QueryClient
}

function renderAt(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRouteWithContext<TestRouterContext>()()
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: IndexRoute.options.component!,
    beforeLoad: IndexRoute.options.beforeLoad,
    validateSearch: IndexRoute.options.validateSearch,
    loader: IndexRoute.options.loader,
  })
  const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/dashboard',
    component: () => <div>Dashboard stub</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, dashboardRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    context: { queryClient },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

async function expectLandingVisible() {
  expect(
    await screen.findByRole('heading', {
      level: 1,
      name: /play more\.\s*pay never\./i,
    }),
  ).toBeInTheDocument()
}

describe('/ route', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('renders the landing page when the user has not entered the app', async () => {
    renderAt('/')
    await expectLandingVisible()
  })

  it('redirects to /dashboard when the user has entered the app', async () => {
    window.localStorage.setItem(APP_ENTERED_KEY, '1')
    renderAt('/')
    expect(await screen.findByText('Dashboard stub')).toBeInTheDocument()
  })

  it('shows the landing page when ?landing=1 is set, even after entering the app', async () => {
    window.localStorage.setItem(APP_ENTERED_KEY, '1')
    renderAt('/?landing=1')
    await expectLandingVisible()
  })

  it('has no inert href="#" anchors on the landing page', async () => {
    const { container } = renderAt('/')
    await expectLandingVisible()

    // Every link must go somewhere real: an in-app route, an off-site URL, or
    // an in-page section anchor (#product etc.). A bare href="#" is a no-op CTA
    // and regresses issue #437.
    const inert = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('a[href="#"]'),
    )
    expect(inert).toHaveLength(0)
  })

  it('wires the footer GitHub links to the public repository', async () => {
    renderAt('/')
    await expectLandingVisible()

    for (const link of screen.getAllByRole('link', { name: /github|contribute/i })) {
      expect(link).toHaveAttribute(
        'href',
        'https://github.com/mightymoose/fortymm',
      )
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    }
  })

  it('renders affordances that do not exist yet as inert, non-link text', async () => {
    renderAt('/')
    await expectLandingVisible()

    // "Get the Android app" has no destination yet — there is no Android build
    // at all — so it must not be a clickable link. (Its iOS neighbour *is* a
    // link now: the TestFlight beta is public. See `App.test.tsx`.)
    expect(
      screen.queryByRole('link', { name: /get the android app/i }),
    ).not.toBeInTheDocument()
    // Footer "Discord" has no invite URL yet — also not a link.
    expect(
      screen.queryByRole('link', { name: /^discord$/i }),
    ).not.toBeInTheDocument()
  })
})
