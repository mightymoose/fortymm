import { createFileRoute } from '@tanstack/react-router'
import { NotificationPreferencesPage } from '@/components/notifications/notification-preferences-page'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/notifications/settings')({
  head: () => ({
    meta: [{ title: pageTitle('Notification settings') }],
  }),
  component: NotificationPreferencesPage,
})
