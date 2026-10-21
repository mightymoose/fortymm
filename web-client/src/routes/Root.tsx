import { Outlet } from '@tanstack/react-router'

// Wraps every page in the app's page chrome (`.page` in styles/base.css).
export function Root() {
  return (
    <div className="page">
      <Outlet />
    </div>
  )
}
