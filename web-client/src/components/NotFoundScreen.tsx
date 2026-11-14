import { Link } from '@tanstack/react-router'

// The not-found page, shown for any URL that matches no route (the root
// route's notFoundComponent).
export function NotFoundScreen() {
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
