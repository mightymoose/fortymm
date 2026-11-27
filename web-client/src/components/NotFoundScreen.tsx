import { Link } from '@tanstack/react-router'

export function NotFoundScreen() {
  return (
    <main>
      <h1>Page not found</h1>
      <p>
        <Link to="/">Go to the home page</Link>
      </p>
    </main>
  )
}
