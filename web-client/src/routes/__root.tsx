import { createRootRoute, Outlet } from '@tanstack/react-router'
import { AppLayout } from '../components/AppLayout.tsx'
import { NotFoundScreen } from '../components/NotFoundScreen.tsx'

// The root route: every screen renders in its <Outlet />, inside the layout
// every screen shares (AppLayout): the one place a route renders more than a
// single component.
export const Route = createRootRoute({
  component: () => (
    <AppLayout>
      <Outlet />
    </AppLayout>
  ),
  // Shown for any URL that matches no route file, inside the layout.
  notFoundComponent: NotFoundScreen,
})
