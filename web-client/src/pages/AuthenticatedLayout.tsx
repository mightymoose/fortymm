import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Outlet, useRouteContext } from '@tanstack/react-router'
import { Suspense } from 'react'
import { sessionQuery } from '../api/queries'
import { LoadingScreen } from '../components/LoadingScreen'
import { AppShell } from './AppShell'
import { SignInErrorAlert } from './SignInErrorAlert'

// The layout of the pages that will need a signed-in user: AppShell around
// the page, and the message of a sign-in that came back with an error. It shows the loading screen over it until the page stops
// suspending. The page
// renders under it before it fades out. The session starts once per page
// load, so coming back to these pages later doesn't show the loading screen.
export function AuthenticatedLayout() {
  const { api } = useRouteContext({ from: '__root__' })
  const { isSuccess: ready } = useQuery(sessionQuery(api))

  return (
    <>
      <AppShell>
        <SignInErrorAlert />
        <Suspense fallback={null}>
          <AuthenticatedPage />
        </Suspense>
      </AppShell>
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
