import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Link, Outlet, useRouteContext } from '@tanstack/react-router'
import { Suspense, useState } from 'react'
import { healthQuery } from '../api/queries'
import { LoadingScreen } from '../components/LoadingScreen'

// Shows the loading screen over the page until the page's layout stops
// suspending, then fades it out. The page renders under it as the fade
// starts. Root stays mounted across client-side navigation, so the loading
// screen doesn't come back.
export function Root() {
  const { api } = useRouteContext({ from: '__root__' })
  const { isSuccess: ready } = useQuery(healthQuery(api))
  const [loadingScreenGone, setLoadingScreenGone] = useState(false)

  return (
    <>
      <Suspense fallback={null}>
        <Layout />
      </Suspense>
      {!loadingScreenGone && (
        <LoadingScreen
          leaving={ready}
          onLeft={() => setLoadingScreenGone(true)}
        />
      )}
    </>
  )
}

// Wraps every page in the app's page chrome (`.page` in styles/base.css).
// It suspends until the API's health check answers, once per page load.
function Layout() {
  const { api } = useRouteContext({ from: '__root__' })
  useSuspenseQuery(healthQuery(api))

  return (
    <div className="page">
      {/* Temporary navigation between the pages while the app is built out. */}
      <nav className="toc" aria-label="Pages">
        <Link to="/">Home</Link>
        <Link to="/design-system">Design System</Link>
      </nav>
      <Outlet />
    </div>
  )
}
