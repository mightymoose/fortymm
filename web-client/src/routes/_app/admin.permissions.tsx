import { createFileRoute } from '@tanstack/react-router'
import { PermissionsPage } from '@/components/rbac/permissions-page'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/_app/admin/permissions')({
  head: () => ({
    meta: [{ title: pageTitle('Permissions · Admin') }],
  }),
  component: PermissionsPage,
})
