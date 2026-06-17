import { Outlet, createFileRoute } from '@tanstack/react-router'
import { AdminBreadcrumbAndCounts } from '@/components/rbac/admin-layout'
import { RbacBoundary } from '@/components/rbac/error-fallback'

export const Route = createFileRoute('/_app/admin')({
  component: AdminLayout,
})

function AdminLayout() {
  return (
    <>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: 'calc(100vh - 64px)',
          minHeight: 0,
        }}
      >
        <RbacBoundary>
          <AdminBreadcrumbAndCounts />
        </RbacBoundary>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <RbacBoundary>
            <Outlet />
          </RbacBoundary>
        </div>
      </div>
    </>
  )
}
