import { useCallback, useState } from 'react'
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
import { useAutoMarkRead } from './use-auto-mark-read'
import { useFollowNotification } from './use-follow-notification'
import { useStickyUnread } from './use-sticky-unread'

/** Route container for the full notifications page — wires the feed query, the
 * filter state, and the mark-read mutations to the pure view. */
export function NotificationsPage() {
  const feed = useNotificationFeed()
  const taxonomy = useNotificationTaxonomy()
  const [filter, setFilter] = useState<NotificationFilter>('all')
  const follow = useFollowNotification()
  const markAll = useMarkAllNotificationsRead()
  const markSeen = useAutoMarkRead()
  const { pinned: stickyUnread, remember, forget } = useStickyUnread(
    filter === 'unread',
  )

  // A row that scrolls into view auto-marks-read AND gets pinned, so viewing it
  // doesn't drop it off the Unread filter mid-read (#762).
  const handleSeen = useCallback(
    (id: string) => {
      remember(id)
      markSeen(id)
    },
    [remember, markSeen],
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

  return (
    <NotificationsView
      items={feed.data.items}
      categoryTypes={taxonomy.data.types}
      unreadCount={feed.data.unread_count}
      filter={filter}
      onFilterChange={setFilter}
      onActivate={follow}
      onMarkAllRead={handleMarkAllRead}
      onSeen={handleSeen}
      stickyUnread={stickyUnread}
    />
  )
}
