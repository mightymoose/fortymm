import { createFileRoute } from '@tanstack/react-router'
import { UsersPage } from '@/components/rbac/users-page'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/admin/users')({
  head: () => ({
    meta: [{ title: pageTitle('Users · Admin') }],
  }),
  component: UsersPage,
})
