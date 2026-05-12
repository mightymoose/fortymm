import { Outlet, createFileRoute } from '@tanstack/react-router'
import { AppShell } from '@/components/app-shell'
import { RbacProvider } from '@/components/rbac/rbac-context'
import { AdminBreadcrumbAndCounts } from '@/components/rbac/admin-layout'

export const Route = createFileRoute('/admin')({
  component: AdminLayout,
})

function AdminLayout() {
  return (
    <RbacProvider>
      <AppShell>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            height: 'calc(100vh - 64px)',
            minHeight: 0,
          }}
        >
          <AdminBreadcrumbAndCounts />
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            <Outlet />
          </div>
        </div>
      </AppShell>
    </RbacProvider>
  )
}
