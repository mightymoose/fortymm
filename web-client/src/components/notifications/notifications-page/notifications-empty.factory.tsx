import type { NotificationsEmptyProps } from './notifications-empty'

export function buildNotificationsEmptyProps(
  overrides: Partial<NotificationsEmptyProps> = {},
): NotificationsEmptyProps {
  return {
    state: { kind: 'inbox-empty' },
    onShowAll: () => {},
    ...overrides,
  }
}
