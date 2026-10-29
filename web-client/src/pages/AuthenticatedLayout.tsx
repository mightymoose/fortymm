import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Outlet, useRouteContext } from '@tanstack/react-router'
import { Suspense } from 'react'
import { sessionQuery } from '../api/queries'
import { LoadingScreen } from '../components/LoadingScreen'

// The layout of the pages that will need a signed-in user. It shows the
// loading screen over the page until the page stops suspending. The page
// renders under it before it fades out. The session starts once per page
// load, so coming back to these pages later doesn't show the loading screen.
export function AuthenticatedLayout() {
  const { api } = useRouteContext({ from: '__root__' })
  const { isSuccess: ready } = useQuery(sessionQuery(api))

  return (
    <>
      <Suspense fallback={null}>
        <AuthenticatedPage />
      </Suspense>
      <LoadingScreen ready={ready} />
    </>
  )
}

// Suspends until the session has started.
function AuthenticatedPage() {
  const { api } = useRouteContext({ from: '__root__' })
  useSuspenseQuery(sessionQuery(api))

  return <Outlet />
}
