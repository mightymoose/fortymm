import { Link, Outlet, useRouteContext } from '@tanstack/react-router'
import { Suspense, use } from 'react'
import { LoadingScreen } from '../components/LoadingScreen'

// Shows the loading screen until the page's layout stops suspending.
export function Root() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Layout />
    </Suspense>
  )
}

// Wraps every page in the app's page chrome (`.page` in styles/base.css).
// It suspends on the router's loading screen delay, which resolves once per
// page load, so client-side navigation doesn't bring the loading screen back.
function Layout() {
  use(useRouteContext({ from: '__root__' }).loadingScreenDelay)

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
