import { Outlet, createFileRoute } from '@tanstack/react-router'

import { RbacBoundary } from '@/components/rbac/error-fallback'

// Wrap both the list and the detail in the RbacBoundary as a general error
// boundary: viewing tournaments needs no permission any more (#1092), so the
// server-side 403 it used to catch cannot happen for a default user — but the
// boundary still renders the "no access" UI for any 403 that could ever come
// back (a revoked `tournament.create` grant mid-session, say) rather than
// crashing the route.
export const Route = createFileRoute('/_app/tournaments')({
  component: TournamentsLayout,
})

function TournamentsLayout() {
  return (
    <RbacBoundary>
      <Outlet />
    </RbacBoundary>
  )
}
