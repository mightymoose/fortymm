import { createFileRoute } from '@tanstack/react-router'
import { NotificationsPage } from '@/components/notifications/notifications-page'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/_app/notifications/')({
  head: () => ({
    meta: [{ title: pageTitle('Notifications') }],
  }),
  component: NotificationsPage,
})
