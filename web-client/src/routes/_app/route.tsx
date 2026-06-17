import { Outlet, createFileRoute } from '@tanstack/react-router'
import { AppShell } from '@/components/app-shell'
import { RootLoader } from '@/components/root-loader'
import { sessionQueryOptions } from '@/api/session'

/**
 * Pathless layout for every in-app surface. Its loader establishes the session
 * once — `ensureQueryData` mints (or loads) the guest and is single-flighted by
 * TanStack Query — and the route does not render its children until that
 * resolves. So the session cookie is set before any child loader or BFF query
 * fires, which keeps the displayed identity in sync with the cookie and stops
 * concurrent cold-load requests from each minting a different guest (#487).
 *
 * Pathless (`_app`) → adds no URL segment, so child paths (`/dashboard`,
 * `/matches`, …) are unchanged. The chrome lives here so children render only
 * their page content.
 */
export const Route = createFileRoute('/_app')({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(sessionQueryOptions()),
  pendingComponent: RootLoader,
  component: AppLayout,
})

function AppLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}
