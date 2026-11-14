import { createRootRoute, Outlet } from '@tanstack/react-router'
import { NotFoundScreen } from '../components/NotFoundScreen.tsx'

// The root route: every screen renders in its <Outlet />, with no markup
// around it. A layout every screen shares would be a component in
// src/components/ wrapping the <Outlet />.
export const Route = createRootRoute({
  component: Outlet,
  // Shown for any URL that matches no route file.
  notFoundComponent: NotFoundScreen,
})
