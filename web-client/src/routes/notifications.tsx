import { Outlet, createFileRoute } from '@tanstack/react-router'
import { AppShell } from '@/components/app-shell'

// Layout route: the app chrome + an Outlet for the notifications sub-pages
// (index = the feed list, /settings = the preferences matrix). The children
// must render through this Outlet, so don't turn this back into a leaf page.
export const Route = createFileRoute('/notifications')({
  component: NotificationsLayout,
})

function NotificationsLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}
