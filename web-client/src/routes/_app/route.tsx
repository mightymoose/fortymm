import { Outlet, createFileRoute } from '@tanstack/react-router'
import { AppShell } from '@/components/app-shell'
import { AppError } from '@/components/app-error'
import { RootLoader } from '@/components/root-loader'
import { sessionQueryOptions } from '@/api/session'

/**
 * Pathless layout for every in-app surface. Its loader establishes the session
 * once — `ensureQueryData` mints (or loads) the guest and is single-flighted by
 * TanStack Query within this tab — and the route does not render its children
 * until that resolves. So the session cookie is set before any child loader or
 * BFF query fires, which keeps the displayed identity in sync with the cookie
 * and stops concurrent cold-load requests *within one tab* from each minting a
 * different guest (#487). Across tabs, the `queryFn` in `sessionQueryOptions`
 * (api/session.ts) additionally single-flights the cold bootstrap
 * origin-wide, so several tabs opened at once still converge on one guest
 * (#824).
 *
 * Pathless (`_app`) → adds no URL segment, so child paths (`/dashboard`,
 * `/matches`, …) are unchanged. The chrome lives here so children render only
 * their page content.
 *
 * `errorComponent` owns the session-bootstrap failure (#292): when the loader's
 * `ensureQueryData` rejects, every session-gated child page (`enabled:
 * session.isSuccess`) would otherwise sit on a silent forever-skeleton. Routing
 * it here gives a branded retry. Scoped to `_app` (not a global
 * `defaultErrorComponent`) on purpose: this boundary sits outside AppShell, so
 * it never lands *inside* a child's own React error boundary the way a
 * per-route default would (e.g. the admin/tournament `RbacBoundary` that wraps
 * its `<Outlet>` — a global default would shadow its 403/error handling).
 */
export const Route = createFileRoute('/_app')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(sessionQueryOptions()),
  pendingComponent: RootLoader,
  errorComponent: AppError,
  component: AppLayout,
})

function AppLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}
