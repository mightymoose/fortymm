import { createFileRoute } from '@tanstack/react-router'
import { PermissionsPage } from '@/components/rbac/permissions-page'

export const Route = createFileRoute('/admin/permissions')({
  head: () => ({
    meta: [{ title: 'Permissions · Admin · FortyMM' }],
  }),
  component: PermissionsPage,
})
