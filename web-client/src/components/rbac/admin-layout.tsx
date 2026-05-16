import { useRouterState } from '@tanstack/react-router'
import { useSession } from '@/api/session'
import { Skeleton } from '@/components/ui/skeleton'
import { usePermissions, useRbacUsers, useRoles } from './queries'

const TAB_LABELS: Record<string, string> = {
  '/admin/roles': 'Roles',
  '/admin/permissions': 'Permissions',
  '/admin/users': 'Users',
}

export function AdminBreadcrumbAndCounts() {
  const { data: session } = useSession()
  // /v1/roles, /v1/permissions, /v1/users are all gated on authorization.manage,
  // so administration.view-only users would 403 and trip the error boundary.
  const canManageAuth =
    session?.data.user.permissions.includes('authorization.manage') ?? false
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const current = TAB_LABELS[pathname] ?? 'Overview'

  return (
    <div
      style={{
        height: 56,
        display: 'flex',
        alignItems: 'center',
        padding: '0 24px',
        gap: 14,
        borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--bg-app)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>Administration</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--fg-muted)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 6l6 6-6 6" />
        </svg>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg-1)' }}>{current}</span>
      </div>
      <div style={{ flex: 1 }} />
      {canManageAuth && <AdminCountsPill />}
    </div>
  )
}

function AdminCountsPill() {
  const usersQ = useRbacUsers()
  const rolesQ = useRoles()
  const permsQ = usePermissions()
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        padding: '4px 12px',
        borderRadius: 999,
        background: 'var(--bg-card)',
        border: '1px solid var(--border-subtle)',
        fontSize: 11,
        fontFamily: 'var(--font-mono)',
        color: 'var(--fg-3)',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: 'var(--serve-500)',
          boxShadow: '0 0 6px var(--serve-500)',
          animation: 'ball-pulse 1.4s ease-in-out infinite',
        }}
      />
      <CountChip label="users" count={usersQ.data?.length} loading={usersQ.isLoading} />
      <span style={{ color: 'var(--ink-500)' }}>·</span>
      <CountChip label="roles" count={rolesQ.data?.length} loading={rolesQ.isLoading} />
      <span style={{ color: 'var(--ink-500)' }}>·</span>
      <CountChip label="perms" count={permsQ.data?.length} loading={permsQ.isLoading} />
    </div>
  )
}

function CountChip({
  label,
  count,
  loading,
}: {
  label: string
  count: number | undefined
  loading: boolean
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {loading ? (
        <Skeleton className="h-3 w-5" />
      ) : (
        <span style={{ color: 'var(--fg-1)', fontWeight: 600 }}>{count ?? 0}</span>
      )}
      <span>{label}</span>
    </span>
  )
}
