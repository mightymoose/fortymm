import { createFileRoute } from '@tanstack/react-router'
import { DashboardPage } from '@/components/dashboard/dashboard-page'
import { pageTitle } from '@/lib/page-title'

export const Route = createFileRoute('/_app/dashboard')({
  head: () => ({
    meta: [{ title: pageTitle('Dashboard') }],
  }),
  component: DashboardPage,
})
