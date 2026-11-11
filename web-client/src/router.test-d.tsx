// Type-level tests, checked by `tsc -b` (web-client:typecheck). Nothing here
// runs or ships: no module imports this file.
import { Link, useNavigate } from '@tanstack/react-router'

export function LinksToRoutesThatExist() {
  const navigate = useNavigate()
  void navigate({ to: '/' })
  void navigate({ to: '/health' })
  return (
    <>
      <Link to="/">Start</Link>
      <Link to="/health">API health</Link>
    </>
  )
}

// Each marked line must be a type error. If the router were not registered
// (see `Register` in router.ts), any string would be accepted, each
// expect-error directive would be unused, and tsc would fail.
export function LinksToRoutesThatDoNotExist() {
  const navigate = useNavigate()
  // @ts-expect-error: no route file for /no-such-route
  void navigate({ to: '/no-such-route' })
  // @ts-expect-error: no route file for /no-such-route
  return <Link to="/no-such-route">Nowhere</Link>
}
