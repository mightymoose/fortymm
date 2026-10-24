import { Link, Outlet } from '@tanstack/react-router'
import { ToastProvider } from '../components/ToastProvider'
import { TooltipProvider } from '../components/TooltipProvider'

// Wraps every page in the app's page chrome (`.page` in styles/base.css),
// and gives every page toasts and tooltips.
export function Root() {
  return (
    <ToastProvider>
      <TooltipProvider>
        <div className="page">
          {/* Temporary navigation between the pages while the app is built out. */}
          <nav className="page-links" aria-label="Pages">
            <Link to="/">Home</Link>
            <Link to="/design-system">Design System</Link>
          </nav>
          <Outlet />
        </div>
      </TooltipProvider>
    </ToastProvider>
  )
}
