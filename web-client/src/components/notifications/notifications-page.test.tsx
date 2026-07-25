import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { http, HttpResponse } from 'msw'
import {
  notificationFeedQueryOptions,
  type NotificationFeed,
  type NotificationItem,
} from '@/api/notifications'
import { server } from '@/mocks/server'
import { act, render, screen, waitFor } from '@/test/utilities'
import { buildNotificationItem } from './notification-row.factory'
import { notificationsViewPage } from './notifications-page/notifications-view.page'
import { Route } from '@/routes/_app/notifications.index'

const READ_AT = '2026-07-03T00:00:00.000Z'

// What the feed returns the moment you arrive: two unread rows and one that was
// already read before you got here.
function arrivalFeed(): NotificationItem[] {
  return [
    buildNotificationItem({
      id: 'n-a',
      title: 'Accept your score',
      read_at: null,
    }),
    buildNotificationItem({
      id: 'n-b',
      title: 'Match reminder tonight',
      read_at: null,
    }),
    buildNotificationItem({
      id: 'n-c',
      title: 'Rating +12',
      read_at: READ_AT,
    }),
  ]
}

function feedResponse(items: NotificationItem[]): NotificationFeed {
  return { items, unread_count: items.filter((i) => i.read_at == null).length }
}

// Mount the real route component under a memory router so the filter lives in
// the URL exactly as it does in production — `initialEntry` seeds the starting
// location (e.g. `/notifications?filter=unread` for a deep-link/reload). The
// taxonomy endpoint is served by the default MSW handlers.
function renderPage(feed: NotificationFeed, initialEntry = '/notifications') {
  server.use(http.get('*/v1/notifications', () => HttpResponse.json(feed)))
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const rootRoute = createRootRoute()
  const notificationsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/notifications/',
    component: Route.options.component!,
    validateSearch: Route.options.validateSearch,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([notificationsRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { queryClient, router }
}

describe('NotificationsPage — Unread is an arrival snapshot (#996)', () => {
  it('lands on All, auto-reads every row, and still lists the arrival-unread rows under Unread', async () => {
    const items = arrivalFeed()
    const { queryClient } = renderPage(feedResponse(items))

    // Arrive on the default All filter; every row (read or not) is listed.
    await waitFor(() =>
      expect(
        notificationsViewPage.queryTitle('Accept your score'),
      ).toBeInTheDocument(),
    )
    expect(notificationsViewPage.getFilter('All')).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    // Auto-mark-on-view fires while we sit on All: the optimistic cache write
    // flips both arrival-unread rows to read in the very feed this page renders.
    act(() => {
      queryClient.setQueryData<NotificationFeed>(
        notificationFeedQueryOptions().queryKey,
        feedResponse(
          items.map((item) =>
            item.id === 'n-c' ? item : { ...item, read_at: READ_AT },
          ),
        ),
      )
    })

    // Only now do we click Unread. Pre-fix, the snapshot was gated on the Unread
    // filter being active, so nothing was captured while we were on All and this
    // list would be empty. Post-fix, the arrival snapshot keeps them visible.
    await notificationsViewPage.clickFilter('Unread')

    expect(
      notificationsViewPage.queryTitle('Accept your score'),
    ).toBeInTheDocument()
    expect(
      notificationsViewPage.queryTitle('Match reminder tonight'),
    ).toBeInTheDocument()
    // Not the filter-empty state.
    expect(notificationsViewPage.queryShowAll()).not.toBeInTheDocument()

    // A row already read on arrival was never "new since you got here", so it is
    // not pinned and does not appear under Unread.
    expect(notificationsViewPage.queryTitle('Rating +12')).not.toBeInTheDocument()
  })
})

describe('NotificationsPage — the descoped rating_change category is hidden (#998)', () => {
  it('omits the Rating filter pill but keeps the other category pills', async () => {
    // The default MSW handler serves the full server taxonomy, rating_change
    // included; the client-side taxonomy `select` is what drops the pill.
    renderPage(feedResponse(arrivalFeed()))
    await waitFor(() =>
      expect(
        notificationsViewPage.queryTitle('Accept your score'),
      ).toBeInTheDocument(),
    )

    // Other server categories still render their pills (so this can't pass by
    // rendering no pills at all)…
    expect(notificationsViewPage.getFilter('Tourney')).toBeInTheDocument()
    expect(notificationsViewPage.getFilter('Scores')).toBeInTheDocument()
    expect(notificationsViewPage.getFilter('Calls')).toBeInTheDocument()
    // …but rating_change (short label "Rating") is filtered out client-side.
    // Fails before the fix, where the taxonomy is rendered unfiltered.
    expect(
      screen.queryByRole('button', { name: 'Rating' }),
    ).not.toBeInTheDocument()
  })
})

describe('NotificationsPage — the filter lives in the URL (#999)', () => {
  it('writes ?filter=unread to the URL when the Unread pill is clicked', async () => {
    const { router } = renderPage(feedResponse(arrivalFeed()))
    await waitFor(() =>
      expect(
        notificationsViewPage.queryTitle('Accept your score'),
      ).toBeInTheDocument(),
    )

    // Fails against useState-only: the pill would flip local state and never
    // touch the URL, so a filtered view stays unlinkable.
    await notificationsViewPage.clickFilter('Unread')
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ filter: 'unread' }),
    )
  })

  it('clears the param back to a clean URL when All is reselected', async () => {
    const { router } = renderPage(feedResponse(arrivalFeed()), '/notifications?filter=unread')
    await waitFor(() =>
      expect(notificationsViewPage.getFilter('Unread')).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )

    // Default (All) is represented by an absent param — the URL stays clean.
    await notificationsViewPage.clickFilter('All')
    await waitFor(() => expect(router.state.location.search).toEqual({}))
  })

  it('renders the Unread view when mounted at ?filter=unread (survives reload)', async () => {
    const items = arrivalFeed()
    renderPage(feedResponse(items), '/notifications?filter=unread')

    // Fails against useState-only: the initial state is hardcoded 'all', so a
    // deep-link/reload would land on All and show the already-read row too.
    await waitFor(() =>
      expect(notificationsViewPage.getFilter('Unread')).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
    // The two arrival-unread rows show…
    expect(
      notificationsViewPage.queryTitle('Accept your score'),
    ).toBeInTheDocument()
    expect(
      notificationsViewPage.queryTitle('Match reminder tonight'),
    ).toBeInTheDocument()
    // …but the row already read before arrival does not.
    expect(notificationsViewPage.queryTitle('Rating +12')).not.toBeInTheDocument()
  })

  it('falls back to All for a bogus ?filter value rather than an empty filtered view', async () => {
    const items = arrivalFeed()
    renderPage(feedResponse(items), '/notifications?filter=xyz')

    // A slug no category owns degrades to All — not a filter-empty "Show all"
    // state. Fails against a naive normalize that passes 'xyz' through to the
    // view's `category === 'xyz'` predicate (which matches nothing).
    await waitFor(() =>
      expect(notificationsViewPage.getFilter('All')).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
    expect(notificationsViewPage.queryShowAll()).not.toBeInTheDocument()
    // Every row shows, including the one read before arrival.
    expect(
      notificationsViewPage.queryTitle('Accept your score'),
    ).toBeInTheDocument()
    expect(notificationsViewPage.queryTitle('Rating +12')).toBeInTheDocument()
  })
})
