import type { NotificationItem } from '@/api/notifications'
import { buildNotificationItem } from '../notification-row.factory'
import type { NotificationsViewProps } from './notifications-view'

/** A realistic feed: one unread score-confirmation plus a read rating change and
 * a read tournament update — enough to exercise the filters. */
export function buildNotificationsItems(): NotificationItem[] {
  return [
    buildNotificationItem({
      id: 'n-1',
      category: 'result_confirm',
      title: 'Confirm your score',
      read_at: null,
    }),
    buildNotificationItem({
      id: 'n-2',
      category: 'rating_change',
      title: 'Rating +12',
      body: "You're now 1,847.",
      delta: '+12',
      link: null,
      action_label: null,
      read_at: '2026-06-17T10:00:00.000Z',
    }),
    buildNotificationItem({
      id: 'n-3',
      category: 'tournament',
      title: 'Spring Open · R16 posted',
      body: 'You play the winner of Tran / Chen.',
      link: null,
      action_label: 'See draw',
      read_at: '2026-06-17T09:00:00.000Z',
    }),
  ]
}

export function buildNotificationsViewProps(
  overrides: Partial<NotificationsViewProps> = {},
): NotificationsViewProps {
  return {
    items: buildNotificationsItems(),
    unreadCount: 1,
    filter: 'all',
    onFilterChange: () => {},
    onActivate: () => {},
    onMarkAllRead: () => {},
    ...overrides,
  }
}
