import { Outlet, createFileRoute } from '@tanstack/react-router'

// Layout for the notifications surfaces — the chrome (AppShell) comes from the
// _app layout, so this only provides the Outlet that hosts the feed list
// (index) and the preferences matrix (/settings). Keep it a layout (not a leaf)
// so the children render.
export const Route = createFileRoute('/_app/notifications')({
  component: NotificationsLayout,
})

function NotificationsLayout() {
  return <Outlet />
}
