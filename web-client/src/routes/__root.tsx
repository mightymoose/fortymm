import { createRootRoute, Link, Outlet } from '@tanstack/react-router'

// The layout every screen shares. Each file in src/routes renders inside the
// <Outlet />.
export const Route = createRootRoute({
  component: RootLayout,
  // Shown for any URL that matches no route file.
  notFoundComponent: NotFound,
})

function RootLayout() {
  return <Outlet />
}

function NotFound() {
  return (
    <section id="center">
      <div>
        <h1>Page not found</h1>
        <p>There is nothing at this address.</p>
      </div>
      <Link to="/">Go to the start page</Link>
    </section>
  )
}
