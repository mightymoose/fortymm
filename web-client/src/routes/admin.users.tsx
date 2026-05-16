import { createFileRoute } from '@tanstack/react-router'
import { UsersPage } from '@/components/rbac/users-page'

export const Route = createFileRoute('/admin/users')({
  head: () => ({
    meta: [{ title: 'Users · Admin · FortyMM' }],
  }),
  component: UsersPage,
})
