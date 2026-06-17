import { createFileRoute } from '@tanstack/react-router'
import { AppShell } from '@/components/app-shell'
import { NotificationsPage } from '@/components/notifications/notifications-page'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/notifications')({
  head: () => ({
    meta: [{ title: pageTitle('Notifications') }],
  }),
  component: NotificationsRoute,
})

function NotificationsRoute() {
  return (
    <AppShell>
      <NotificationsPage />
    </AppShell>
  )
}
