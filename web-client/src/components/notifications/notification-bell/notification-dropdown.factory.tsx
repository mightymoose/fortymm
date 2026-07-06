import type { NotificationItem } from '@/api/notifications'
import { buildNotificationItem } from '../notification-row.factory'
import type { NotificationDropdownProps } from './notification-dropdown'

/** A short feed: one unread score-confirmation and one read rating change. */
export function buildDropdownItems(): NotificationItem[] {
  return [
    buildNotificationItem({ id: 'n-1', title: 'Accept your score' }),
    buildNotificationItem({
      id: 'n-2',
      category: 'rating_change',
      title: 'Rating +12',
      body: "You're now 1,847. Best of the month.",
      delta: '+12',
      link: null,
      action_label: null,
      read_at: '2026-06-17T10:00:00.000Z',
    }),
  ]
}

export function buildNotificationDropdownProps(
  overrides: Partial<NotificationDropdownProps> = {},
): NotificationDropdownProps {
  return {
    items: buildDropdownItems(),
    unreadCount: 1,
    isLoading: false,
    onActivate: () => {},
    onMarkAllRead: () => {},
    onSeeAll: () => {},
    ...overrides,
  }
}
