import { useRouterState } from '@tanstack/react-router'
import { useRbacData } from './use-rbac'

const TAB_LABELS: Record<string, string> = {
  '/admin/roles': 'Roles',
  '/admin/permissions': 'Permissions',
  '/admin/users': 'Users',
}

export function AdminBreadcrumbAndCounts() {
  const { users, roles, permissions } = useRbacData()
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
        <span>
          <span style={{ color: 'var(--fg-1)', fontWeight: 600 }}>{users.length}</span> users
        </span>
        <span style={{ color: 'var(--ink-500)' }}>·</span>
        <span>
          <span style={{ color: 'var(--fg-1)', fontWeight: 600 }}>{roles.length}</span> roles
        </span>
        <span style={{ color: 'var(--ink-500)' }}>·</span>
        <span>
          <span style={{ color: 'var(--fg-1)', fontWeight: 600 }}>{permissions.length}</span> perms
        </span>
      </div>
    </div>
  )
}
