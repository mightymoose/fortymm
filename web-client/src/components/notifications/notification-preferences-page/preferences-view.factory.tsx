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
    onToggleChannel: () => {},
    onToggleCell: () => {},
    ...overrides,
  }
}
