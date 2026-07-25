import { createFileRoute } from '@tanstack/react-router'
import { zodValidator } from '@tanstack/zod-adapter'
import { NotificationsPage } from '@/components/notifications/notifications-page'
import { notificationsSearchSchema } from '@/components/notifications/notifications-page/notifications-search'
import { pageTitle } from '@/lib/page-title'

// Re-exported so deep-link tests can read the search schema off the route module.
export { notificationsSearchSchema } from '@/components/notifications/notifications-page/notifications-search'

export const Route = createFileRoute('/_app/notifications/')({
  head: () => ({
    meta: [{ title: pageTitle('Notifications') }],
  }),
  // The active filter lives in the URL (`?filter=…`), Zod-parsed at the route
  // boundary — a malformed value falls back to All instead of throwing (#999).
  validateSearch: zodValidator(notificationsSearchSchema),
  component: NotificationsPage,
})
