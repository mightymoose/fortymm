import { useRouter } from '@tanstack/react-router'
import { useMarkNotificationRead, type NotificationItem } from '@/api/notifications'

/**
 * The shared "open a notification" action used by the bell and the
 * notifications page: mark it read (if it wasn't) and follow its deep link.
 *
 * Navigation goes through `router.history.push` rather than a typed `<Link>`
 * because the link is a server-provided runtime string (e.g. `/matches/<id>`),
 * not a statically-known route — `history.push` still navigates client-side.
 */
export function useFollowNotification() {
  const router = useRouter()
  const markRead = useMarkNotificationRead()

  return (notification: NotificationItem) => {
    if (notification.read_at == null) {
      markRead.mutate(notification.id)
    }
    if (notification.link) {
      void router.history.push(notification.link)
    }
  }
}
