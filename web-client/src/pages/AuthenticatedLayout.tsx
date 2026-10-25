import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Outlet, useRouteContext } from '@tanstack/react-router'
import { Suspense } from 'react'
import { healthQuery } from '../api/queries'
import { LoadingScreen } from '../components/LoadingScreen'
import { AppShell } from './AppShell'

// The layout of the pages that will need a signed-in user: AppShell around
// the page. It shows the loading screen over it until the page stops
// suspending. The page
// renders under it before it fades out. Health is checked once per page load,
// so coming back to these pages later doesn't show the loading screen.
export function AuthenticatedLayout() {
  const { api } = useRouteContext({ from: '__root__' })
  const { isSuccess: ready } = useQuery(healthQuery(api))

  return (
    <>
      <AppShell>
        <Suspense fallback={null}>
          <AuthenticatedPage />
        </Suspense>
      </AppShell>
      <LoadingScreen ready={ready} />
    </>
  )
}

// Suspends until the API's health check answers.
function AuthenticatedPage() {
  const { api } = useRouteContext({ from: '__root__' })
  useSuspenseQuery(healthQuery(api))

  return <Outlet />
}
