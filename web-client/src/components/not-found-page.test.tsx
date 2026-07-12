import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { NotFoundPage } from './not-found-page'
import { notFoundContentPage } from './not-found-content.page'

function renderAt(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const dashboardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/dashboard',
    component: () => <div>Dashboard route</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([dashboardRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
    defaultNotFoundComponent: NotFoundPage,
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('NotFoundPage', () => {
  it('renders the 404 for an unknown route, echoing the requested path', async () => {
    renderAt('/this-page-does-not-exist')

    expect(
      await screen.findByRole('heading', { name: /page not\s*found/i }),
    ).toBeInTheDocument()
    // The meta line echoes the path the user actually hit.
    expect(
      screen.getByText('/this-page-does-not-exist'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /back to dashboard/i }),
    ).toHaveAttribute('href', '/dashboard')
  })

  it('renders exactly one <main> landmark — it owns the only app shell', async () => {
    renderAt('/this-page-does-not-exist')
    await screen.findByRole('heading', { name: /page not\s*found/i })

    // The regression this guards: `NotFoundPage` supplies the `AppShell`, and
    // `NotFoundContent` supplies none — so nothing here nests two shells. A
    // route already under the `_app` layout must render `NotFoundContent`, not
    // this component, or the page grows a second <main>.
    expect(notFoundContentPage.getMainLandmarks()).toHaveLength(1)
  })

  it('recovers to the dashboard when the action is clicked', async () => {
    const user = userEvent.setup()
    renderAt('/nope')

    await user.click(
      await screen.findByRole('link', { name: /back to dashboard/i }),
    )
    expect(await screen.findByText('Dashboard route')).toBeInTheDocument()
  })
})
