import { createRootRoute, Outlet } from '@tanstack/react-router'
import { NotFoundScreen } from '../components/NotFoundScreen.tsx'

export const Route = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFoundScreen,
})
