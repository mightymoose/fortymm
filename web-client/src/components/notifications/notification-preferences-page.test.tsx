import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { render, screen, waitFor } from '@/test/utilities'
import { Route } from '@/routes/_app/notifications.settings'

// Mount the real settings route (container → preferences query + taxonomy →
// PreferencesView) so the matrix rows come through the *actual* preferences
// `select`. The default MSW handlers serve the full server preferences +
// taxonomy — rating_change included — so any hiding is the client's doing.
function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/notifications/settings',
    component: Route.options.component!,
  })
  // The deep-link target any channel setup-nudge <Link> resolves against.
  const settingsPageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/settings',
    component: () => <div>settings</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute, settingsPageRoute]),
    history: createMemoryHistory({
      initialEntries: ['/notifications/settings'],
    }),
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('NotificationPreferencesPage — the descoped rating_change category is hidden (#998)', () => {
  it('omits the "Rating changes" matrix row but keeps the other category rows', async () => {
    renderPage()

    // Wait for the matrix to resolve — another category row proves it rendered
    // (so this can't pass by rendering an empty matrix).
    await waitFor(() =>
      expect(screen.getByText('Match reminders')).toBeInTheDocument(),
    )
    expect(screen.getByText('Tournament news')).toBeInTheDocument()
    expect(screen.getByText('Score acceptances')).toBeInTheDocument()

    // The rating_change row (label "Rating changes") is filtered out of the
    // preferences `categories` client-side. Fails before the fix, where the
    // matrix renders every seeded category including this one.
    expect(screen.queryByText('Rating changes')).not.toBeInTheDocument()
    // …and so is every one of its per-channel toggle cells.
    expect(
      screen.queryByRole('checkbox', { name: /^Rating changes via/ }),
    ).not.toBeInTheDocument()
  })
})
