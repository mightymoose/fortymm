import { createFileRoute } from '@tanstack/react-router'
import { RolesPage } from '@/components/rbac/roles-page'

export const Route = createFileRoute('/admin/roles')({
  component: RolesPage,
})
