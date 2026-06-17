import {
  useNotificationPreferences,
  useUpdateNotificationPreferences,
} from '@/api/notifications'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { PreferencesView } from './notification-preferences-page/preferences-view'

/** Route container for the notification settings page — wires the preferences
 * query + partial-update mutation to the pure matrix view. */
export function NotificationPreferencesPage() {
  const preferences = useNotificationPreferences()
  const update = useUpdateNotificationPreferences()

  if (preferences.isPending) {
    return (
      <p className="mx-auto max-w-[840px] px-6 pt-9 text-sm text-[color:var(--fg-muted)]">
        Loading preferences…
      </p>
    )
  }

  if (preferences.isError) {
    return (
      <div className="mx-auto max-w-[840px] px-6 pt-9">
        <Alert variant="destructive">
          <AlertTitle>Couldn't load your preferences</AlertTitle>
          <AlertDescription>Refresh to try again.</AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <PreferencesView
      preferences={preferences.data}
      onToggleChannel={(channel, enabled) =>
        update.mutate({ channels: [{ channel, enabled }], cells: [] })
      }
      onToggleCell={(category, channel, enabled) =>
        update.mutate({ channels: [], cells: [{ category, channel, enabled }] })
      }
    />
  )
}
