import { Link, Outlet } from '@tanstack/react-router'

// Wraps every page in the app's page chrome (`.page` in styles/base.css).
export function Root() {
  return (
    <div className="page">
      {/* Temporary navigation between the pages while the app is built out. */}
      <nav className="page-links" aria-label="Pages">
        <Link to="/">Home</Link>
        <Link to="/design-system">Design System</Link>
      </nav>
      <Outlet />
    </div>
  )
}
