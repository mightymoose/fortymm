import { createFileRoute } from '@tanstack/react-router'
import { RolesPage } from '@/components/rbac/roles-page'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/_app/admin/roles')({
  head: () => ({
    meta: [{ title: pageTitle('Roles · Admin') }],
  }),
  component: RolesPage,
})
