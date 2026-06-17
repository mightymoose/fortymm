import { Outlet, createFileRoute } from '@tanstack/react-router'

import { RbacBoundary } from '@/components/rbac/error-fallback'

// Wrap both the list and the detail in the RbacBoundary so a server-side 403
// (a user without `tournament.manage`) renders the "no access" UI rather than
// crashing the route — the list query's `throwOnError` surfaces the 403 here.
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
