import { createFileRoute } from '@tanstack/react-router'
import { AppShell } from '@/components/app-shell'
import { NotificationPreferencesPage } from '@/components/notifications/notification-preferences-page'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/settings/notifications')({
  head: () => ({
    meta: [{ title: pageTitle('Notifications · Settings') }],
  }),
  component: SettingsNotificationsRoute,
})

function SettingsNotificationsRoute() {
  return (
    <AppShell>
      <NotificationPreferencesPage />
    </AppShell>
  )
}
