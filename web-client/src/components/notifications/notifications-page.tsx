import { useCallback } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import {
  useMarkAllNotificationsRead,
  useNotificationFeed,
  useNotificationTaxonomy,
} from '@/api/notifications'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  NotificationsView,
  type NotificationFilter,
} from './notifications-page/notifications-view'
import {
  normalizeNotificationFilter,
  type NotificationsSearch,
} from './notifications-page/notifications-search'
import { useAutoMarkRead } from './use-auto-mark-read'
import { useFollowNotification } from './use-follow-notification'
import { useStickyUnread } from './use-sticky-unread'

/** Route container for the full notifications page — wires the feed query, the
 * URL-backed filter, and the mark-read mutations to the pure view. */
export function NotificationsPage() {
  const feed = useNotificationFeed()
  const taxonomy = useNotificationTaxonomy()
  // The active filter is URL state (`?filter=…`), validated at the route
  // boundary. Read it route-agnostically (`strict: false`) so the same
  // component mounts under both the real `/notifications/` route and a test's
  // memory-router harness without importing the Route object (import-cycle
  // guard). Writes go back to the URL via `navigate`, so a filtered view is
  // linkable, survives reload, and steps through browser Back (#999).
  const search = useSearch({ strict: false }) as NotificationsSearch
  const navigate = useNavigate()
  const follow = useFollowNotification()
  const markAll = useMarkAllNotificationsRead()
  const markSeen = useAutoMarkRead()
  // The Unread snapshot is captured on arrival (first feed resolve) from the feed
  // itself, independent of the landing filter — see `useStickyUnread` (#996).
  // Reading the filter from the URL rather than local state does not change
  // when/how this snapshot is taken: it still keys off the feed, not the filter.
  const { pinned: stickyUnread, forget } = useStickyUnread(feed.data?.items)

  const setFilter = useCallback(
    (next: NotificationFilter) => {
      void navigate({
        to: '/notifications',
        replace: true,
        // Default (All) drops the param so the URL stays clean; every other
        // filter is written verbatim.
        search: (prev) => ({
          ...prev,
          filter: next === 'all' ? undefined : next,
        }),
      })
    },
    [navigate],
  )

  // "Mark all read" is an explicit bulk dismiss — forget the snapshot so the
  // Unread list actually empties instead of leaving the just-read rows pinned.
  const handleMarkAllRead = useCallback(() => {
    forget()
    markAll.mutate()
  }, [forget, markAll])

  if (feed.isPending || taxonomy.isPending) {
    return (
      <p className="mx-auto max-w-[760px] px-6 pt-9 text-sm text-[color:var(--fg-muted)]">
        Loading notifications…
      </p>
    )
  }

  if (feed.isError || taxonomy.isError) {
    return (
      <div className="mx-auto max-w-[760px] px-6 pt-9">
        <Alert variant="destructive">
          <AlertTitle>Couldn't load your notifications</AlertTitle>
          <AlertDescription>Refresh to try again.</AlertDescription>
        </Alert>
      </div>
    )
  }

  // Resolve the raw URL slug against the taxonomy now that it's loaded: an
  // unknown/stale slug degrades to All rather than rendering an empty filter.
  const filter = normalizeNotificationFilter(search.filter, taxonomy.data.types)

  return (
    <NotificationsView
      items={feed.data.items}
      categoryTypes={taxonomy.data.types}
      unreadCount={feed.data.unread_count}
      filter={filter}
      onFilterChange={setFilter}
      onActivate={follow}
      onMarkAllRead={handleMarkAllRead}
      onSeen={markSeen}
      stickyUnread={stickyUnread}
    />
  )
}
