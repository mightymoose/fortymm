import { Outlet, useRouteContext } from '@tanstack/react-router'
import { Suspense, use } from 'react'
import { LoadingScreen } from '../components/LoadingScreen'

// The layout of the pages that will need a signed-in user. It shows the
// loading screen until the page under it stops suspending.
export function AuthenticatedLayout() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <AuthenticatedPage />
    </Suspense>
  )
}

// Suspends on the router's loading screen delay, which resolves once per page
// load, so client-side navigation doesn't bring the loading screen back.
function AuthenticatedPage() {
  use(useRouteContext({ from: '__root__' }).loadingScreenDelay)

  return <Outlet />
}
