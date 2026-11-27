import { createRootRoute } from '@tanstack/react-router'
import { NotFoundScreen } from '../components/NotFoundScreen.tsx'
import { RootLayout } from '../components/RootLayout.tsx'

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundScreen,
})
