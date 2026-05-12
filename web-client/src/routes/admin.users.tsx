import { createFileRoute } from '@tanstack/react-router'
import { UsersPage } from '@/components/rbac/users-page'

export const Route = createFileRoute('/admin/users')({
  component: UsersPage,
})
