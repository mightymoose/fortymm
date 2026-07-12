import type { NotificationPreferences } from '@/api/notifications'
import {
  notificationPreferences,
  notificationTaxonomy,
} from '@/test/factories'
import type { PreferencesViewProps } from './preferences-view'

/** Default scenario: the out-of-the-box preferences (in-app locked on, push +
 * email on, SMS unavailable; match reminders locked on for in-app/push). */
export function buildPreferencesViewProps(
  overrides: Partial<PreferencesViewProps> = {},
): PreferencesViewProps {
  return {
    preferences: notificationPreferences(),
    taxonomy: notificationTaxonomy(),
    pendingEmail: null,
    onToggleChannel: () => {},
    onToggleCell: () => {},
    ...overrides,
  }
}

/** A guest who has wired nothing up: no confirmed email address, no registered
 * push device. The server still resolves both masters to `enabled: true` (the
 * default) but marks them `setup_required` with a destination that says so —
 * so this is the state in which an "on" switch would be lying (#892). */
export function preferencesAwaitingSetup(): NotificationPreferences {
  const base = notificationPreferences()
  return {
    ...base,
    channels: base.channels.map((channel) => {
      if (channel.channel === 'email')
        return {
          ...channel,
          setup_required: true,
          destination: 'Add an email in settings',
        }
      if (channel.channel === 'push')
        return {
          ...channel,
          setup_required: true,
          destination: 'No devices yet',
        }
      return channel
    }),
  }
}
