import { AccessDenied } from '@/components/rbac/error-fallback'
import { SystemHealth } from '@/components/system-health'
import { useHasPermission, useSession } from '@/api/session'
import { PERM } from '@/lib/permissions'

/** Route gate for the Administration Overview. Unlike the RBAC and broadcast
 * surfaces — whose data endpoints 403 for the unauthorized and trip the
 * `RbacBoundary` — this page's only fetch is the *public* `/v1/health`, so
 * nothing ever 403s. The page must therefore check `administration.view`
 * itself before rendering the system-health dashboard, which otherwise
 * discloses internal service hostnames to a signed-out guest (see #622). */
export function AdminOverview() {
  const { isPending } = useSession()
  const canViewAdmin = useHasPermission(PERM.ADMIN_VIEW)
  // `useHasPermission` reads false while the session is in flight; wait it out
  // so an authorized user never flashes the access-denied panel.
  if (isPending) return null
  if (!canViewAdmin) return <AccessDenied />

  return (
    <div className="mx-auto max-w-[1200px] px-12 pt-16 pb-32">
      <header className="mb-10">
        <h1 className="font-display text-4xl text-foreground">Administration</h1>
      </header>
      <section aria-label="Operations" className="mb-12 max-w-[640px]">
        <SystemHealth />
      </section>
    </div>
  )
}
