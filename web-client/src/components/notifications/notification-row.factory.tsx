import type { NotificationItem } from '@/api/notifications'
import type { NotificationRowProps } from './notification-row'

/** A fixed "now" so relative-time labels are deterministic in tests. */
export const ROW_NOW = new Date('2026-06-17T12:00:00.000Z')

/** Default scenario: an unread score-confirmation, posted two minutes ago, with
 * a deep link and a "Review" call-to-action. */
export function buildNotificationItem(
  overrides: Partial<NotificationItem> = {},
): NotificationItem {
  return {
    id: 'n-1',
    category: 'result_confirm',
    title: 'Confirm your score',
    body: 'def. Patel, M. — you logged 3–1. Tap to confirm.',
    link: '/matches/m-1',
    action_label: 'Review',
    delta: null,
    read_at: null,
    created_at: '2026-06-17T11:58:00.000Z',
    ...overrides,
  }
}

export function buildNotificationRowProps(
  overrides: Partial<NotificationRowProps> = {},
): NotificationRowProps {
  return {
    notification: buildNotificationItem(),
    now: ROW_NOW,
    ...overrides,
  }
}
